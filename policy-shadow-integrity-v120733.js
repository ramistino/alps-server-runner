'use strict';

const current = require('./policy-shadow-integrity-v12073');
const v12072 = require('./policy-shadow-integrity-v12072');

const {
  SERVICE_VERSION,
  SHADOW_VERSION,
  stableHash,
  ARM_DEFS,
  canonicalPolicyStateVector,
} = current;

const INTEGRITY_PATCH_VERSION = 'v12.0.7.3.3-policy-state-boundary-canonicalization-fix';
const PREVIOUS_INTEGRITY_PATCH_VERSION = current.INTEGRITY_PATCH_VERSION;
const POLICY_STATE_SCHEMA_VERSION = 'v12073-canonical-policy-state-1.2';
const PATCH_BOUNDARY_AT = '2026-07-25T18:24:51.000Z';
const CLASSIFICATION_SCHEMA = 'alps.gen2.sourceDivergenceClassificationEvent.v12073';
const MAX_POLICY_STATE_TELEMETRY_RECORDS = 64;

function iso(value = Date.now()) {
  return new Date(value).toISOString();
}

function unique(values) {
  return [...new Set((values || []).filter(value => value != null && value !== ''))].sort();
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function materializePolicyStateAtBoundary(value) {
  const undefinedPaths = [];
  const seen = new WeakSet();

  const visit = (currentValue, pathValue) => {
    if (currentValue === undefined) {
      undefinedPaths.push(pathValue);
      return null;
    }
    if (currentValue === null) return null;

    const type = typeof currentValue;
    if (type !== 'object') return currentValue;
    if (
      currentValue instanceof Date ||
      currentValue instanceof Map ||
      currentValue instanceof Set ||
      currentValue instanceof RegExp
    ) {
      return currentValue;
    }
    if (seen.has(currentValue)) throw new TypeError('POLICY_STATE_CYCLE_FORBIDDEN');

    seen.add(currentValue);
    try {
      if (Array.isArray(currentValue)) {
        const output = new Array(currentValue.length);
        for (let index = 0; index < currentValue.length; index++) {
          const itemPath = `${pathValue}[${index}]`;
          if (!own(currentValue, index)) {
            undefinedPaths.push(itemPath);
            output[index] = null;
          } else {
            output[index] = visit(currentValue[index], itemPath);
          }
        }
        return output;
      }

      const proto = Object.getPrototypeOf(currentValue);
      if (proto !== Object.prototype && proto !== null) return currentValue;

      const output = {};
      for (const key of Object.keys(currentValue)) {
        output[key] = visit(currentValue[key], `${pathValue}.${key}`);
      }
      return output;
    } finally {
      seen.delete(currentValue);
    }
  };

  return {
    policyState:visit(value, '$'),
    undefinedPaths,
  };
}

function ensureBoundaryMetrics(engine) {
  if (!engine.reportingMetrics || typeof engine.reportingMetrics !== 'object') engine.reportingMetrics = {};
  const metrics = engine.reportingMetrics;
  if (!Number.isFinite(Number(metrics.policyStateUndefinedMaterializations))) metrics.policyStateUndefinedMaterializations = 0;
  if (!Array.isArray(metrics.policyStateUndefinedPaths)) metrics.policyStateUndefinedPaths = [];
  if (!Array.isArray(metrics.policyStateUndefinedMaterializationRecords)) metrics.policyStateUndefinedMaterializationRecords = [];
  if (!Number.isFinite(Number(metrics.policyStateCanonicalizationFailures))) metrics.policyStateCanonicalizationFailures = 0;
  if (!own(metrics, 'lastPolicyStateCanonicalizationFailure')) metrics.lastPolicyStateCanonicalizationFailure = null;
  return metrics;
}

function boundaryContext(engine, context = {}) {
  return {
    runId:context.runId || engine.policyBoundaryTelemetry && engine.policyBoundaryTelemetry.currentRunId || null,
    frameKey:context.frameKey || null,
    baseEvidenceClusterId:context.baseEvidenceClusterId || null,
    revisionIndex:Number.isFinite(Number(context.revisionIndex)) ? Number(context.revisionIndex) : null,
    clusterIndex:Number.isFinite(Number(context.clusterIndex)) ? Number(context.clusterIndex) : null,
    armId:context.armId || null,
    side:context.side || null,
  };
}

function recordUndefinedMaterializations(engine, paths, context) {
  if (!paths.length) return;
  const metrics = ensureBoundaryMetrics(engine);
  const resolved = boundaryContext(engine, context);
  const observedAt = iso(engine.now ? engine.now() : Date.now());

  metrics.policyStateUndefinedMaterializations += paths.length;
  for (const undefinedPath of paths) {
    const record = { ...resolved, undefinedPath, observedAt };
    const recordKey = [
      record.runId,
      record.frameKey,
      record.baseEvidenceClusterId,
      record.revisionIndex,
      record.clusterIndex,
      record.armId,
      record.side,
      record.undefinedPath,
    ].join('|');

    if (!metrics.policyStateUndefinedMaterializationRecords.some(existing => existing.recordKey === recordKey)) {
      metrics.policyStateUndefinedMaterializationRecords.push({ recordKey, ...record });
      metrics.policyStateUndefinedMaterializationRecords = metrics.policyStateUndefinedMaterializationRecords.slice(-MAX_POLICY_STATE_TELEMETRY_RECORDS);
    }

    const legacyPath = [
      record.frameKey || 'UNKNOWN_FRAME',
      record.baseEvidenceClusterId || 'UNKNOWN_CLUSTER',
      record.armId || 'UNKNOWN_ARM',
      record.side || 'UNKNOWN_SIDE',
      undefinedPath,
    ].join('|');
    metrics.policyStateUndefinedPaths = unique([...metrics.policyStateUndefinedPaths, legacyPath]).slice(-MAX_POLICY_STATE_TELEMETRY_RECORDS);
  }
}

function recordCanonicalizationFailure(engine, error, context) {
  const metrics = ensureBoundaryMetrics(engine);
  const resolved = boundaryContext(engine, context);
  const failure = {
    ...resolved,
    error:error && error.message || String(error),
    observedAt:iso(engine.now ? engine.now() : Date.now()),
  };
  metrics.policyStateCanonicalizationFailures += 1;
  metrics.lastPolicyStateCanonicalizationFailure = failure;
  return failure;
}

function canonicalPolicyStateVectorAtBoundary(engine, policyState, context = {}) {
  const materialized = materializePolicyStateAtBoundary(policyState);
  recordUndefinedMaterializations(engine, materialized.undefinedPaths, context);

  try {
    return {
      ...canonicalPolicyStateVector(materialized.policyState),
      undefinedMaterializationCount:materialized.undefinedPaths.length,
      undefinedMaterializationPaths:materialized.undefinedPaths,
    };
  } catch (error) {
    const failure = recordCanonicalizationFailure(engine, error, context);
    const parts = [
      failure.frameKey,
      failure.baseEvidenceClusterId,
      failure.armId,
      failure.side,
      failure.error,
    ].filter(Boolean);
    const wrapped = new TypeError(`POLICY_STATE_CANONICALIZATION_FAILED:${parts.join(':')}`);
    wrapped.cause = error;
    wrapped.policyStateContext = failure;
    throw wrapped;
  }
}

function scopeKeysForOutcome(engine, outcome) {
  try {
    return engine.scopesForOutcome(outcome).map(scope => `${scope.scopeType}|${scope.scopeId}`);
  } catch (_) {
    return ['GLOBAL|GLOBAL'];
  }
}

function witnessClassificationEvent({ revision, terminalClass, status, affectedClusterIds, scopeKeys, nowAt, decisionChanged }) {
  const evidence = {
    frameKey:revision.frameKey,
    symbolKey:revision.symbolKey,
    timeframe:revision.timeframe,
    candleOpenTime:revision.row.t,
    firstRowHash:revision.firstRowHash,
    revisedRowHash:revision.revisedRowHash,
    changedFields:revision.changedFields,
    affectedClusterIds:unique(affectedClusterIds),
    decisionChanged:decisionChanged === true,
  };
  const sourceRecordHash = stableHash(evidence);
  const classificationSubjectKey = stableHash({
    sourceRecordHash,
    taxonomyHash:current.TAXONOMY_HASH,
    classificationAlgorithmVersion:current.CLASSIFICATION_ALGORITHM_VERSION,
  });
  const evidenceFingerprint = stableHash({ ...evidence, policyCodeFingerprint:SHADOW_VERSION });
  const classificationSequence = 1;
  const classificationEventKey = stableHash({
    classificationSubjectKey,
    classificationSequence,
    classificationStatus:status,
    evidenceFingerprint,
  });

  return {
    schema:CLASSIFICATION_SCHEMA,
    serviceVersion:SERVICE_VERSION,
    integrityPatchVersion:INTEGRITY_PATCH_VERSION,
    taxonomyHash:current.TAXONOMY_HASH,
    classificationAlgorithmVersion:current.CLASSIFICATION_ALGORITHM_VERSION,
    policyCodeFingerprint:SHADOW_VERSION,
    sourceRecordHash,
    classificationSubjectKey,
    classificationEventKey,
    classificationSequence,
    previousClassificationEventKey:null,
    originType:'WITNESS_ROW_REVISION',
    terminalClass,
    classificationStatus:status,
    transitionReason:'FIRST_COMMITTED_WITNESS_ROW_RETAINED_AND_REVISED_PATH_RECOMPUTED',
    evidenceFingerprint,
    observedAt:revision.observedAt || nowAt,
    classifiedAt:nowAt,
    timing:Date.parse(revision.observedAt || nowAt) < Date.parse(PATCH_BOUNDARY_AT) ? 'PRE_PATCH' : 'POST_PATCH',
    symbolKey:revision.symbolKey,
    timeframe:revision.timeframe,
    candleOpenTime:revision.row.t,
    changedFields:revision.changedFields,
    affectedClusterIds:unique(affectedClusterIds),
    scopeKeys:unique(scopeKeys),
    decisionChanged:decisionChanged === true,
    resolution:'ABSORBED_BY_WITNESS',
    paperOnly:true,
    promotionEnabled:false,
  };
}

function runIdFor(engine, reason) {
  engine.policyBoundaryRunSequence = Number(engine.policyBoundaryRunSequence || 0) + 1;
  const nowAt = iso(engine.now ? engine.now() : Date.now());
  return `PS733-${stableHash({ nowAt, reason:String(reason || 'scheduled'), sequence:engine.policyBoundaryRunSequence, pid:process.pid }).slice(0, 16)}`;
}

function persistedRunTelemetry(telemetry) {
  return {
    lastSuccessfulRunId:telemetry.lastSuccessfulRunId || null,
    lastSuccessfulRunCompletedAt:telemetry.lastSuccessfulRunCompletedAt || null,
    lastErrorAt:telemetry.lastErrorAt || null,
    lastErrorRunId:telemetry.lastErrorRunId || null,
    lastError:telemetry.lastError || null,
    lastRunOutcome:telemetry.lastRunOutcome || null,
  };
}

class PolicyShadowEngine extends current.PolicyShadowEngine {
  constructor(...args) {
    super(...args);
    const persisted = this.state && this.state.policyBoundaryTelemetry || {};
    this.policyBoundaryRunSequence = 0;
    this.policyBoundaryTelemetry = {
      currentRunId:null,
      currentRunStartedAt:null,
      lastSuccessfulRunId:persisted.lastSuccessfulRunId || null,
      lastSuccessfulRunCompletedAt:persisted.lastSuccessfulRunCompletedAt || null,
      lastErrorAt:persisted.lastErrorAt || null,
      lastErrorRunId:persisted.lastErrorRunId || null,
      lastError:persisted.lastError || null,
      lastRunOutcome:persisted.lastRunOutcome || null,
    };
    ensureBoundaryMetrics(this);
  }

  async init() {
    await super.init();
    const persisted = this.state && this.state.policyBoundaryTelemetry || {};
    this.policyBoundaryTelemetry = {
      ...this.policyBoundaryTelemetry,
      lastSuccessfulRunId:persisted.lastSuccessfulRunId || this.policyBoundaryTelemetry.lastSuccessfulRunId || null,
      lastSuccessfulRunCompletedAt:persisted.lastSuccessfulRunCompletedAt || this.policyBoundaryTelemetry.lastSuccessfulRunCompletedAt || null,
      lastErrorAt:persisted.lastErrorAt || this.policyBoundaryTelemetry.lastErrorAt || null,
      lastErrorRunId:persisted.lastErrorRunId || this.policyBoundaryTelemetry.lastErrorRunId || null,
      lastError:persisted.lastError || this.policyBoundaryTelemetry.lastError || null,
      lastRunOutcome:persisted.lastRunOutcome || this.policyBoundaryTelemetry.lastRunOutcome || null,
    };
    ensureBoundaryMetrics(this);
    return this.view();
  }

  async processFrameClusters(frameClusters, source, controlStates, controlCutoffMs, witnessEvents) {
    const outcomes = await v12072.PolicyShadowEngine.prototype.processFrameClusters.call(
      this,
      frameClusters,
      source,
      controlStates,
      controlCutoffMs,
      witnessEvents,
    );
    if (!Array.isArray(frameClusters) || !frameClusters.length) return outcomes;

    const frameKey = `${frameClusters[0].symbolKey}|${frameClusters[0].timeframe}`;
    await this.yieldForHealth('FRAME_BASE_PROCESS_COMPLETE', {
      phase:'FRAME_BASE_PROCESS_COMPLETE',
      frameKey,
      clusterCount:frameClusters.length,
    });

    const revisions = this.witnessRevisionRecordsByFrame.get(frameKey) || [];
    if (!revisions.length) {
      this.cooperativeYield.lastCompletedFrameKey = frameKey;
      return outcomes;
    }

    const rowsRaw = await this.storage.readCrypto(
      this.config.crypto.cleanDir,
      frameClusters[0].symbolKey,
      frameClusters[0].timeframe,
    );
    const authoritativeCandles = this.frameCandles(
      frameClusters[0].symbolKey,
      frameClusters[0].timeframe,
      frameClusters[0].intervalMs,
      rowsRaw,
      controlCutoffMs,
    );
    const outcomeById = new Map(outcomes.map(outcome => [outcome.baseEvidenceClusterId, outcome]));
    const totalClusterEvaluations = revisions.length * frameClusters.length;
    let processedClusterEvaluations = 0;
    let processedSinceYield = 0;
    let lastYieldAt = Date.now();

    this.cooperativeYield.inProgress = true;
    this.cooperativeYield.phase = 'WITNESS_REVISION_RECOMPUTE';
    this.cooperativeYield.frameKey = frameKey;
    this.cooperativeYield.revisionCount = revisions.length;
    this.cooperativeYield.clusterCount = frameClusters.length;
    this.cooperativeYield.processedClusterEvaluations = 0;
    this.cooperativeYield.totalClusterEvaluations = totalClusterEvaluations;
    this.cooperativeYield.lastProgressAt = iso(this.now());

    try {
      for (let revisionIndex = 0; revisionIndex < revisions.length; revisionIndex++) {
        const revision = revisions[revisionIndex];
        await this.yieldForHealth('WITNESS_REVISION_BEGIN', {
          phase:'WITNESS_REVISION_RECOMPUTE',
          frameKey,
          revisionIndex:revisionIndex + 1,
          revisionCount:revisions.length,
          clusterIndex:0,
          clusterCount:frameClusters.length,
          processedClusterEvaluations,
          totalClusterEvaluations,
        });
        lastYieldAt = Date.now();
        processedSinceYield = 0;

        const revisedCandles = authoritativeCandles.map(row => row.t === revision.row.t ? { ...revision.row } : { ...row });
        const affectedClusterIds = [];
        const scopeKeys = new Set(['GLOBAL|GLOBAL']);
        let decisionChanged = false;

        for (let clusterIndex = 0; clusterIndex < frameClusters.length; clusterIndex++) {
          if (processedSinceYield > 0 && current.shouldCooperativeYield({
            processedSinceYield,
            elapsedMs:Date.now() - lastYieldAt,
            batchSize:this.cooperativeYield.clusterBatchSize,
            maxBlockMs:this.cooperativeYield.maxBlockMs,
          })) {
            await this.yieldForHealth('WITNESS_REVISION_CLUSTER_BATCH', {
              phase:'WITNESS_REVISION_RECOMPUTE',
              frameKey,
              revisionIndex:revisionIndex + 1,
              revisionCount:revisions.length,
              clusterIndex:clusterIndex + 1,
              clusterCount:frameClusters.length,
              processedClusterEvaluations,
              totalClusterEvaluations,
            });
            processedSinceYield = 0;
            lastYieldAt = Date.now();
          }

          const cluster = frameClusters[clusterIndex];
          try {
            const outcome = outcomeById.get(cluster.baseEvidenceClusterId);
            if (!outcome || outcome.sourceStatus !== 'PASS' || !outcome.arms) continue;

            const revisedArms = this.simulateClusterArmsForCandles(
              cluster,
              revisedCandles,
              controlStates,
              outcome.candleWitnessSegmentHash || stableHash({ frameKey, revision:revision.revisedRowHash }),
            );
            if (!revisedArms) {
              decisionChanged = true;
              affectedClusterIds.push(cluster.baseEvidenceClusterId);
              for (const key of scopeKeysForOutcome(this, outcome)) scopeKeys.add(key);
              outcome.sourceStatus = 'CLASS_C_DECISION_CHANGING_EXCLUSION_VERIFIED';
              outcome.sourceDivergence = unique([
                ...(outcome.sourceDivergence || []),
                'WITNESS_REVISION_RECOMPUTE_CHANGED_OR_UNAVAILABLE',
              ]);
              continue;
            }

            const armIds = unique([...Object.keys(outcome.arms), ...Object.keys(revisedArms)]);
            let equal = true;
            for (const armId of armIds) {
              if (!outcome.arms[armId] || !revisedArms[armId]) {
                equal = false;
                break;
              }

              const contextBase = {
                frameKey,
                baseEvidenceClusterId:cluster.baseEvidenceClusterId,
                revisionIndex:revisionIndex + 1,
                clusterIndex:clusterIndex + 1,
                armId,
              };
              const authoritativeVector = canonicalPolicyStateVectorAtBoundary(
                this,
                outcome.arms[armId],
                { ...contextBase, side:'AUTHORITATIVE' },
              );
              const revisedVector = canonicalPolicyStateVectorAtBoundary(
                this,
                revisedArms[armId],
                { ...contextBase, side:'REVISED' },
              );
              if (authoritativeVector.canonicalPolicyStateHash !== revisedVector.canonicalPolicyStateHash) {
                equal = false;
                break;
              }
            }

            if (!equal) {
              decisionChanged = true;
              affectedClusterIds.push(cluster.baseEvidenceClusterId);
              for (const key of scopeKeysForOutcome(this, outcome)) scopeKeys.add(key);
              outcome.sourceStatus = 'CLASS_C_DECISION_CHANGING_EXCLUSION_VERIFIED';
              outcome.sourceDivergence = unique([
                ...(outcome.sourceDivergence || []),
                'WITNESS_REVISION_DECISION_CHANGING',
              ]);
            }
          } finally {
            processedClusterEvaluations++;
            processedSinceYield++;
            this.cooperativeYield.clusterIndex = clusterIndex + 1;
            this.cooperativeYield.processedClusterEvaluations = processedClusterEvaluations;
            this.cooperativeYield.lastProgressAt = iso(this.now());
          }
        }

        const terminalClass = decisionChanged ? 'C_DECISION_CHANGING' : 'C_NO_CHANGE';
        const status = decisionChanged ? 'EXCLUSION_VERIFIED' : 'INFORMATIONAL';
        this.currentWitnessClassifications.push(witnessClassificationEvent({
          revision,
          terminalClass,
          status,
          affectedClusterIds,
          scopeKeys:[...scopeKeys],
          nowAt:iso(this.now()),
          decisionChanged,
        }));
        revisedCandles.length = 0;

        await this.yieldForHealth('WITNESS_REVISION_COMPLETE', {
          phase:'WITNESS_REVISION_RECOMPUTE',
          frameKey,
          revisionIndex:revisionIndex + 1,
          revisionCount:revisions.length,
          clusterIndex:frameClusters.length,
          clusterCount:frameClusters.length,
          processedClusterEvaluations,
          totalClusterEvaluations,
        });
        processedSinceYield = 0;
        lastYieldAt = Date.now();
      }
    } finally {
      rowsRaw.length = 0;
      authoritativeCandles.length = 0;
      this.cooperativeYield.inProgress = false;
      this.cooperativeYield.phase = 'FRAME_COMPLETE';
      this.cooperativeYield.lastCompletedFrameKey = frameKey;
      this.cooperativeYield.lastProgressAt = iso(this.now());
      await this.yieldForHealth('WITNESS_FRAME_RECOMPUTE_COMPLETE', {
        phase:'FRAME_COMPLETE',
        frameKey,
        revisionIndex:revisions.length,
        revisionCount:revisions.length,
        clusterIndex:frameClusters.length,
        clusterCount:frameClusters.length,
        processedClusterEvaluations,
        totalClusterEvaluations,
      });
    }

    return outcomes;
  }

  async run(reason = 'scheduled') {
    if (this.inFlight) return this.view();

    const runId = runIdFor(this, reason);
    const startedAt = iso(this.now());
    this.policyBoundaryTelemetry.currentRunId = runId;
    this.policyBoundaryTelemetry.currentRunStartedAt = startedAt;
    this.policyBoundaryTelemetry.lastRunOutcome = 'RUNNING';

    let completedSuccessfully = false;
    let deferred = false;
    try {
      await super.run(reason);
      deferred = this.memoryGuards && this.memoryGuards.memoryGuardState === 'MEMORY_SOFT_GUARD_CYCLE_DEFERRED';
      if (!deferred) {
        completedSuccessfully = true;
        const completedAt = iso(this.now());
        this.policyBoundaryTelemetry.lastSuccessfulRunId = runId;
        this.policyBoundaryTelemetry.lastSuccessfulRunCompletedAt = completedAt;
        this.policyBoundaryTelemetry.lastErrorAt = null;
        this.policyBoundaryTelemetry.lastErrorRunId = null;
        this.policyBoundaryTelemetry.lastError = null;
        this.policyBoundaryTelemetry.lastRunOutcome = 'SUCCESS';
        this.state.integrityPatchVersion = INTEGRITY_PATCH_VERSION;
        this.state.lastError = null;
        this.state.policyBoundaryTelemetry = persistedRunTelemetry(this.policyBoundaryTelemetry);
        await this.persistState();
      } else {
        this.policyBoundaryTelemetry.lastRunOutcome = 'DEFERRED_MEMORY_GUARD';
      }
    } catch (error) {
      const failedAt = iso(this.now());
      this.policyBoundaryTelemetry.lastErrorAt = failedAt;
      this.policyBoundaryTelemetry.lastErrorRunId = runId;
      this.policyBoundaryTelemetry.lastError = error && error.stack || String(error);
      this.policyBoundaryTelemetry.lastRunOutcome = 'FAILED';
      throw error;
    } finally {
      this.policyBoundaryTelemetry.currentRunId = null;
      this.policyBoundaryTelemetry.currentRunStartedAt = null;
      if (!completedSuccessfully && !deferred && this.policyBoundaryTelemetry.lastRunOutcome === 'RUNNING') {
        this.policyBoundaryTelemetry.lastRunOutcome = 'RELEASED_WITHOUT_COMPLETION';
      }
    }

    return this.view();
  }

  view() {
    const base = super.view();
    const telemetry = this.policyBoundaryTelemetry || {};
    const lastSuccessAt = Date.parse(telemetry.lastSuccessfulRunCompletedAt || 0);
    const lastErrorAt = Date.parse(telemetry.lastErrorAt || 0);
    let status;
    if (this.inFlight || telemetry.currentRunId) status = 'RUNNING_CATCHUP';
    else if (lastErrorAt > lastSuccessAt) status = 'DEGRADED_LAST_RUN_FAILED';
    else if (!telemetry.lastSuccessfulRunCompletedAt) status = 'PATCH_LOADED_AWAITING_SUCCESSFUL_RUN';
    else status = 'READY_CURRENT';

    const metrics = ensureBoundaryMetrics(this);
    return {
      ...base,
      status,
      integrityPatchVersion:INTEGRITY_PATCH_VERSION,
      previousIntegrityPatchVersion:PREVIOUS_INTEGRITY_PATCH_VERSION,
      currentRunId:telemetry.currentRunId || null,
      currentRunStartedAt:telemetry.currentRunStartedAt || null,
      lastSuccessfulRunId:telemetry.lastSuccessfulRunId || null,
      lastSuccessfulRunCompletedAt:telemetry.lastSuccessfulRunCompletedAt || null,
      lastErrorAt:telemetry.lastErrorAt || null,
      lastErrorRunId:telemetry.lastErrorRunId || null,
      runTelemetry:{ ...telemetry },
      reportingMetrics:{ ...metrics },
      policyStateCanonicalization:{
        ...(base.policyStateCanonicalization || {}),
        schemaVersion:POLICY_STATE_SCHEMA_VERSION,
        undefinedHandling:'FINAL_COMPARISON_BOUNDARY_DEEP_MATERIALIZATION_INCLUDING_ARRAY_HOLES_STRICT_CANONICALIZER_REMAINS_FAIL_CLOSED',
        undefinedMaterializationCount:Number(metrics.policyStateUndefinedMaterializations || 0),
        undefinedMaterializationPaths:[...(metrics.policyStateUndefinedPaths || [])],
        undefinedMaterializationRecords:[...(metrics.policyStateUndefinedMaterializationRecords || [])],
        canonicalizationFailureCount:Number(metrics.policyStateCanonicalizationFailures || 0),
        lastCanonicalizationFailure:metrics.lastPolicyStateCanonicalizationFailure || null,
      },
    };
  }

  diagnosticsView() {
    return {
      ...super.diagnosticsView(),
      integrityPatchVersion:INTEGRITY_PATCH_VERSION,
      runTelemetry:{ ...(this.policyBoundaryTelemetry || {}) },
      policyStateCanonicalization:this.view().policyStateCanonicalization,
    };
  }
}

module.exports = {
  ...current,
  PolicyShadowEngine,
  INTEGRITY_PATCH_VERSION,
  PREVIOUS_INTEGRITY_PATCH_VERSION,
  POLICY_STATE_SCHEMA_VERSION,
  MAX_POLICY_STATE_TELEMETRY_RECORDS,
  materializePolicyStateAtBoundary,
  canonicalPolicyStateVectorAtBoundary,
};
