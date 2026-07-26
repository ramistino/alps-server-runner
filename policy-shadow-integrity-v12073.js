'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');
const v8 = require('v8');
const prior = require('./policy-shadow-integrity-v12072');

const {
  SERVICE_VERSION,
  SHADOW_VERSION,
  CONTROL_VERSION,
  stableHash,
  stableStringify,
  ARM_DEFS,
} = prior;

const INTEGRITY_PATCH_VERSION = 'v12.0.7.3.1-canonical-null-materialization-hotfix';
const PREVIOUS_INTEGRITY_PATCH_VERSION = prior.INTEGRITY_PATCH_VERSION;
const CLASSIFICATION_ALGORITHM_VERSION = 'v12.0.7.3';
const TAXONOMY_SCHEMA = 'alps.gen2.sourceDivergenceTaxonomy.v12073';
const CLASSIFICATION_SCHEMA = 'alps.gen2.sourceDivergenceClassificationEvent.v12073';
const PATCH_BOUNDARY_AT = '2026-07-25T18:24:51.000Z';
const POLICY_STATE_SCHEMA_VERSION = 'v12073-canonical-policy-state-1.1';
const QUARANTINE_WATCH_THRESHOLD = 0.20;
const QUARANTINE_WATCH_MIN_SCOPE_N = 30;
const A2_LOW_MAGNITUDE_ATR_THRESHOLD = 0.05;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const TAXONOMY_MANIFEST_BODY = Object.freeze({
  schema:TAXONOMY_SCHEMA,
  classificationAlgorithmVersion:CLASSIFICATION_ALGORITHM_VERSION,
  status:'FROZEN',
  patchBoundaryAt:PATCH_BOUNDARY_AT,
  originTypes:[
    'WITNESS_ROW_REVISION',
    'NOMINATION_REPLAY_VARIANCE',
    'CLUSTER_MEMBER_ECONOMIC_DIVERGENCE',
    'SOURCE_RECORD_INTEGRITY_FAILURE',
    'UNKNOWN_ORIGIN_BLOCKING',
  ],
  terminalClasses:[
    'A1_VOLUME_OR_METADATA',
    'A2_PRICE_LOW_MAGNITUDE',
    'A3_PRICE_HIGH_MAGNITUDE_WATCH',
    'B_HISTORICAL_REVISION_ABSORBED_NON_DECISION',
    'C_NO_CHANGE',
    'C_DECISION_CHANGING',
    'D_SOURCE_AUTHORITY_VIOLATION',
    'R_NOMINATION_REPLAY_VARIANCE_DIAGNOSTIC_ONLY',
    'M_CLUSTER_MEMBER_ECONOMIC_DIVERGENCE',
    'LEGACY_UNCLASSIFIABLE',
  ],
  thresholds:{
    a2LowMagnitudeAtr:A2_LOW_MAGNITUDE_ATR_THRESHOLD,
    temporaryQuarantineRepresentativenessWatch:QUARANTINE_WATCH_THRESHOLD,
    temporaryQuarantineMinimumScopeN:QUARANTINE_WATCH_MIN_SCOPE_N,
  },
  gates:{
    retired:'CLUSTER_MEMBER_OR_SOURCE_DIVERGENCE_PRESENT',
    authoritative:'UNRESOLVED_ECONOMIC_DIVERGENCE_PRESENT',
  },
  safety:{
    paperOnly:true,
    executionEnabled:false,
    liveCapitalExecution:false,
    promotionEnabled:false,
    candidateEngineMutation:false,
    certifiedLedgerMutation:false,
    v11Writes:0,
  },
});
const TAXONOMY_HASH = stableHash(TAXONOMY_MANIFEST_BODY);

const POLICY_STATE_METADATA_EXCLUSIONS = Object.freeze(new Set([
  'schema',
  'experimentEvidenceClusterId',
  'baseEvidenceClusterId',
  'memberCandidateIds',
  'memberHypothesisIds',
  'families',
  'paperOnly',
  'liveCapitalExecution',
  'promotionEnabled',
  'controlAnchor',
  'controlParity',
  'controlParityStatus',
  'controlParityPolicyDomainExclusions',
  'candleWitnessSegmentHash',
  'sourceReplayVarianceDiagnosticOnly',
]));

function iso(value = Date.now()) { return new Date(value).toISOString(); }
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function round(value, digits = 8) { const n = Number(value); return Number.isFinite(n) ? Number(n.toFixed(digits)) : null; }
function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function unique(values) { return [...new Set((values || []).filter(v => v != null && v !== ''))].sort(); }
function mean(values) { const rows = (values || []).filter(Number.isFinite); return rows.length ? round(rows.reduce((s, v) => s + v, 0) / rows.length) : null; }
function percentile(values, p) {
  const rows = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  if (rows.length === 1) return round(rows[0], 6);
  const index = (rows.length - 1) * p;
  const low = Math.floor(index), high = Math.ceil(index);
  return round(low === high ? rows[low] : rows[low] + (rows[high] - rows[low]) * (index - low), 6);
}
function payloadBytes(value) { return Buffer.byteLength(JSON.stringify(value)); }
function getParam(params, key) {
  if (!params) return null;
  if (typeof params.get === 'function') return params.get(key);
  return params[key] == null ? null : params[key];
}
function boolParam(params, key, fallback = false) {
  const value = getParam(params, key);
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}


function normalizeCandleRow(row, intervalMs) {
  if (!row || typeof row !== 'object') return null;
  const t = finite(row.t ?? row.openTime ?? row.time ?? row.timestamp);
  const out = {
    t,
    o:finite(row.o ?? row.open),
    h:finite(row.h ?? row.high),
    l:finite(row.l ?? row.low),
    c:finite(row.c ?? row.close),
    v:finite(row.v ?? row.volume),
    closeTime:finite(row.closeTime ?? row.endTime) ?? (t == null ? null : t + intervalMs - 1),
    validForSignals:row.validForSignals !== false,
    validForAggregation:row.validForAggregation !== false,
  };
  if (!Number.isFinite(out.t) || ![out.o, out.h, out.l, out.c].every(n => Number.isFinite(n) && n > 0)) return null;
  if (out.h < out.l || out.h < Math.max(out.o, out.c) || out.l > Math.min(out.o, out.c)) return null;
  return out;
}
function canonicalCandleRow(row) {
  return {
    t:row.t,
    o:Number(Number(row.o).toPrecision(12)),
    h:Number(Number(row.h).toPrecision(12)),
    l:Number(Number(row.l).toPrecision(12)),
    c:Number(Number(row.c).toPrecision(12)),
    v:Number.isFinite(Number(row.v)) ? Number(Number(row.v).toPrecision(12)) : null,
    closeTime:row.closeTime,
  };
}
function candleChangedFields(left, right) {
  const fields = [];
  for (const key of ['t','o','h','l','c','v','closeTime']) if (left[key] !== right[key]) fields.push(key);
  return fields;
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
  const classificationSubjectKey = stableHash({ sourceRecordHash, taxonomyHash:TAXONOMY_HASH, classificationAlgorithmVersion:CLASSIFICATION_ALGORITHM_VERSION });
  const evidenceFingerprint = stableHash({ ...evidence, policyCodeFingerprint:SHADOW_VERSION });
  const classificationSequence = 1;
  const classificationEventKey = stableHash({ classificationSubjectKey, classificationSequence, classificationStatus:status, evidenceFingerprint });
  return {
    schema:CLASSIFICATION_SCHEMA,
    serviceVersion:SERVICE_VERSION,
    integrityPatchVersion:INTEGRITY_PATCH_VERSION,
    taxonomyHash:TAXONOMY_HASH,
    classificationAlgorithmVersion:CLASSIFICATION_ALGORITHM_VERSION,
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

function canonicalizeValue(value, seen = new WeakSet()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('POLICY_STATE_NON_FINITE_NUMBER');
    return Object.is(value, -0) ? 0 : value;
  }
  if (type === 'undefined') throw new TypeError('POLICY_STATE_UNDEFINED_FORBIDDEN');
  if (type === 'function' || type === 'symbol' || type === 'bigint') throw new TypeError(`POLICY_STATE_UNSUPPORTED_TYPE:${type}`);
  if (value instanceof Date || value instanceof Map || value instanceof Set || value instanceof RegExp) {
    throw new TypeError(`POLICY_STATE_NON_PLAIN_OBJECT:${value.constructor.name}`);
  }
  if (seen.has(value)) throw new TypeError('POLICY_STATE_CYCLE_FORBIDDEN');
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map(item => canonicalizeValue(item, seen));
    seen.delete(value);
    return result;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new TypeError('POLICY_STATE_NON_PLAIN_OBJECT');
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (POLICY_STATE_METADATA_EXCLUSIONS.has(key)) continue;
    out[key] = canonicalizeValue(value[key], seen);
  }
  seen.delete(value);
  return out;
}

function shapeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return { type:'array', items:value.map(shapeOf) };
  if (typeof value === 'object') {
    return { type:'object', fields:Object.fromEntries(Object.keys(value).sort().map(key => [key, shapeOf(value[key])])) };
  }
  return typeof value;
}

function materializePolicyState(value) {
  const undefinedPaths = [];
  const seen = new WeakSet();
  const visit = (current, pathValue) => {
    if (current === undefined) {
      undefinedPaths.push(pathValue);
      return null;
    }
    if (current === null) return null;
    const type = typeof current;
    if (type !== 'object') return current;
    if (current instanceof Date || current instanceof Map || current instanceof Set || current instanceof RegExp) return current;
    if (seen.has(current)) throw new TypeError('POLICY_STATE_CYCLE_FORBIDDEN');
    seen.add(current);
    if (Array.isArray(current)) {
      const out = current.map((item, index) => visit(item, `${pathValue}[${index}]`));
      seen.delete(current);
      return out;
    }
    const proto = Object.getPrototypeOf(current);
    if (proto !== Object.prototype && proto !== null) {
      seen.delete(current);
      return current;
    }
    const out = {};
    for (const key of Object.keys(current)) out[key] = visit(current[key], `${pathValue}.${key}`);
    seen.delete(current);
    return out;
  };
  return { policyState:visit(value, '$'), undefinedPaths };
}

function canonicalPolicyStateVector(policyState) {
  const canonical = canonicalizeValue(policyState);
  const bytes = stableStringify(canonical);
  const shape = shapeOf(canonical);
  return {
    policyStateSchemaVersion:POLICY_STATE_SCHEMA_VERSION,
    canonicalPolicyStateBytes:bytes,
    canonicalPolicyStateHash:stableHash(canonical),
    policyStateShapeHash:stableHash(shape),
    canonical,
  };
}

function canonicalPolicyStateVectorFromEngineState(policyState) {
  const materialized = materializePolicyState(policyState);
  return {
    ...canonicalPolicyStateVector(materialized.policyState),
    undefinedMaterializationCount:materialized.undefinedPaths.length,
    undefinedMaterializationPaths:materialized.undefinedPaths,
  };
}

function scopeKeysForOutcome(engine, outcome) {
  try {
    return engine.scopesForOutcome(outcome).map(scope => `${scope.scopeType}|${scope.scopeId}`);
  } catch (_) {
    return ['GLOBAL|GLOBAL'];
  }
}

function isReplayReason(reason) {
  return /SETUP_ID_MISMATCH|CONTROL_ZONE_MISMATCH|PLANNED_STOP_MISMATCH|NO_FAMILY_SIGNAL_ON_REPLAY|SETUP_RECONSTRUCTION_FAILED|FAMILY_SIGNAL_REPLAY_VARIANCE/.test(String(reason || ''));
}
function isClusterEconomicReason(reason) {
  return /DIRECTION_DIVERGENCE|SIGNAL_CANDLE_DIVERGENCE|PLANNED_STOP_DIVERGENCE|ENTRY_ZONE_(LOW|HIGH)_DIVERGENCE|CERTIFIED_MEMBER_(ZONE|STOP)_DIVERGENCE|CONTROL_CLUSTER_ENTERED_ECONOMIC_DIVERGENCE/.test(String(reason || ''));
}
function isAuthorityFailureStatus(status) {
  return /WITNESS_AUTHORITY_CONFLICT|SIGNAL_CANDLE_NOT_FOUND|SOURCE_RECORD_INTEGRITY|UNKNOWN_ORIGIN|AUTHORITY_VIOLATION/.test(String(status || ''));
}

function classificationEvent({ outcome, originType, terminalClass, status, reasons, nowAt, diagnosticOnly = false }) {
  const evidence = {
    baseEvidenceClusterId:outcome.baseEvidenceClusterId || null,
    symbolKey:outcome.symbolKey || null,
    timeframe:outcome.timeframe || null,
    sourceStatus:outcome.sourceStatus || null,
    reasons:unique(reasons || []),
    sourceReplayVarianceDiagnosticOnly:diagnosticOnly,
  };
  const sourceRecordHash = stableHash(evidence);
  const classificationSubjectKey = stableHash({ sourceRecordHash, taxonomyHash:TAXONOMY_HASH, classificationAlgorithmVersion:CLASSIFICATION_ALGORITHM_VERSION });
  const evidenceFingerprint = stableHash({ ...evidence, taxonomyHash:TAXONOMY_HASH, policyCodeFingerprint:SHADOW_VERSION });
  const classificationSequence = 1;
  const classificationEventKey = stableHash({ classificationSubjectKey, classificationSequence, classificationStatus:status, evidenceFingerprint });
  return {
    schema:CLASSIFICATION_SCHEMA,
    serviceVersion:SERVICE_VERSION,
    integrityPatchVersion:INTEGRITY_PATCH_VERSION,
    taxonomyHash:TAXONOMY_HASH,
    classificationAlgorithmVersion:CLASSIFICATION_ALGORITHM_VERSION,
    policyCodeFingerprint:SHADOW_VERSION,
    sourceRecordHash,
    classificationSubjectKey,
    classificationEventKey,
    classificationSequence,
    previousClassificationEventKey:null,
    originType,
    terminalClass,
    classificationStatus:status,
    transitionReason:'INITIAL_DETERMINISTIC_CLASSIFICATION',
    evidenceFingerprint,
    observedAt:nowAt,
    classifiedAt:nowAt,
    timing:Date.parse(nowAt) < Date.parse(PATCH_BOUNDARY_AT) ? 'PRE_PATCH' : 'POST_PATCH',
    baseEvidenceClusterId:evidence.baseEvidenceClusterId,
    symbolKey:evidence.symbolKey,
    timeframe:evidence.timeframe,
    sourceStatus:evidence.sourceStatus,
    reasons:evidence.reasons,
    diagnosticOnly,
    paperOnly:true,
    promotionEnabled:false,
  };
}

function emptyScopeTaxonomy() {
  return {
    sourceDivergenceCountHistoricalTotal:0,
    historicalReplayVarianceDiagnosticOnlyCount:0,
    economicSourceDivergenceCount:0,
    unresolvedEconomicDivergenceCount:0,
    permanentlyExcludedClusterCount:0,
    temporarilyQuarantinedClusterCount:0,
    preQuarantineEligibleClusterCount:0,
    temporaryQuarantineShare:0,
    temporaryQuarantineThreshold:QUARANTINE_WATCH_THRESHOLD,
    temporaryQuarantineWatchActive:false,
    divergenceByClass:{ A:0, B:0, C_noChange:0, C_decisionChanging:0, D:0, R:0, M:0, legacy:0 },
  };
}

function ensureScope(summary, key) {
  if (!summary.byScope[key]) summary.byScope[key] = emptyScopeTaxonomy();
  return summary.byScope[key];
}

function buildTaxonomySummary(engine, outcomes, nowAt = iso()) {
  const summary = {
    taxonomyHash:TAXONOMY_HASH,
    classificationAlgorithmVersion:CLASSIFICATION_ALGORITHM_VERSION,
    sourceDivergenceCountHistoricalTotal:0,
    historicalReplayVarianceDiagnosticOnlyCount:0,
    economicSourceDivergenceCount:0,
    unresolvedEconomicDivergenceCount:0,
    permanentlyExcludedClusterCount:0,
    temporarilyQuarantinedClusterCount:0,
    legacyLinkedExcludedCount:0,
    legacyUnlinkedDiagnosticCount:0,
    postPatchUnclassifiableBlockingCount:0,
    byScope:{},
    events:[],
  };
  ensureScope(summary, 'GLOBAL|GLOBAL');

  for (const outcome of outcomes || []) {
    const scopes = scopeKeysForOutcome(engine, outcome);
    if (outcome.sourceStatus === 'PASS') {
      for (const key of scopes) ensureScope(summary, key).preQuarantineEligibleClusterCount++;
    }
    const replayRows = outcome.sourceReplayVarianceDiagnosticOnly || [];
    for (const replay of replayRows) {
      const reasons = replay.reasons || [];
      const event = classificationEvent({
        outcome,
        originType:'NOMINATION_REPLAY_VARIANCE',
        terminalClass:'R_NOMINATION_REPLAY_VARIANCE_DIAGNOSTIC_ONLY',
        status:'INFORMATIONAL',
        reasons,
        nowAt,
        diagnosticOnly:true,
      });
      summary.events.push(event);
      summary.historicalReplayVarianceDiagnosticOnlyCount++;
      for (const key of scopes) {
        const scope = ensureScope(summary, key);
        scope.historicalReplayVarianceDiagnosticOnlyCount++;
        scope.divergenceByClass.R++;
      }
    }

    if (outcome.sourceStatus === 'PASS') continue;
    const reasons = unique(outcome.sourceDivergence || []);
    summary.sourceDivergenceCountHistoricalTotal++;
    for (const key of scopes) ensureScope(summary, key).sourceDivergenceCountHistoricalTotal++;

    let originType;
    let terminalClass;
    let status;
    let unresolved = false;
    let permanentExclusion = false;

    if (isAuthorityFailureStatus(outcome.sourceStatus)) {
      originType = 'SOURCE_RECORD_INTEGRITY_FAILURE';
      terminalClass = 'D_SOURCE_AUTHORITY_VIOLATION';
      status = 'BLOCKING';
      unresolved = true;
    } else if (reasons.length && reasons.every(isReplayReason)) {
      originType = 'NOMINATION_REPLAY_VARIANCE';
      terminalClass = 'R_NOMINATION_REPLAY_VARIANCE_DIAGNOSTIC_ONLY';
      status = 'INFORMATIONAL';
    } else if (reasons.some(isClusterEconomicReason) || /CERTIFIED_NOMINATION_AUTHORITY_DIVERGENCE|SOURCE_RECONSTRUCTION_DIVERGENCE/.test(String(outcome.sourceStatus || ''))) {
      originType = 'CLUSTER_MEMBER_ECONOMIC_DIVERGENCE';
      terminalClass = 'M_CLUSTER_MEMBER_ECONOMIC_DIVERGENCE';
      status = 'EXCLUSION_VERIFIED';
      permanentExclusion = true;
    } else {
      originType = 'UNKNOWN_ORIGIN_BLOCKING';
      terminalClass = 'D_SOURCE_AUTHORITY_VIOLATION';
      status = 'UNCLASSIFIABLE_BLOCKING';
      unresolved = true;
    }

    const event = classificationEvent({ outcome, originType, terminalClass, status, reasons, nowAt, diagnosticOnly:terminalClass.startsWith('R_') });
    summary.events.push(event);

    for (const key of scopes) {
      const scope = ensureScope(summary, key);
      if (terminalClass.startsWith('R_')) {
        scope.historicalReplayVarianceDiagnosticOnlyCount++;
        scope.divergenceByClass.R++;
      } else if (terminalClass.startsWith('M_')) {
        scope.economicSourceDivergenceCount++;
        scope.permanentlyExcludedClusterCount++;
        scope.divergenceByClass.M++;
      } else {
        scope.economicSourceDivergenceCount++;
        scope.unresolvedEconomicDivergenceCount++;
        scope.divergenceByClass.D++;
      }
    }

    if (terminalClass.startsWith('R_')) summary.historicalReplayVarianceDiagnosticOnlyCount++;
    if (!terminalClass.startsWith('R_')) summary.economicSourceDivergenceCount++;
    if (unresolved) summary.unresolvedEconomicDivergenceCount++;
    if (permanentExclusion) summary.permanentlyExcludedClusterCount++;
  }

  for (const scope of Object.values(summary.byScope)) {
    const denominator = scope.preQuarantineEligibleClusterCount;
    scope.temporaryQuarantineShare = denominator > 0 ? round(scope.temporarilyQuarantinedClusterCount / denominator) : 0;
    scope.temporaryQuarantineWatchActive = denominator >= QUARANTINE_WATCH_MIN_SCOPE_N && scope.temporaryQuarantineShare > QUARANTINE_WATCH_THRESHOLD;
  }
  return summary;
}

function outcomeMatchesScope(engine, outcome, scopeType, scopeId) {
  return scopeKeysForOutcome(engine, outcome).includes(`${scopeType}|${scopeId}`);
}

function openTailMetrics(outcomes, row) {
  const legKey = row.leg;
  const scoped = (outcomes || []).filter(outcome => outcome.sourceStatus === 'PASS' && outcomeMatchesScope(this, outcome, row.scopeType, row.scopeId));
  const leftLegs = [];
  const rightLegs = [];
  for (const outcome of scoped) {
    const left = outcome.arms && outcome.arms[row.leftArm];
    const right = outcome.arms && outcome.arms[row.rightArm];
    if (!left || !right) continue;
    if (left.entered && left.legs && left.legs[legKey]) leftLegs.push(left.legs[legKey]);
    if (right.entered && right.legs && right.legs[legKey]) rightLegs.push(right.legs[legKey]);
  }
  const leftOpen = leftLegs.filter(leg => leg.status === 'OPEN');
  const rightOpen = rightLegs.filter(leg => leg.status === 'OPEN');
  const leftAges = leftOpen.map(leg => finite(leg.holdingBars)).filter(Number.isFinite);
  const rightAges = rightOpen.map(leg => finite(leg.holdingBars)).filter(Number.isFinite);
  const leftTimeStops = leftLegs.filter(leg => leg.status === 'TIME_STOP_EXIT').length;
  const rightTimeStops = rightLegs.filter(leg => leg.status === 'TIME_STOP_EXIT').length;
  const leftBeyond = leftOpen.filter(leg => finite(leg.holdingBars) > ({ R1:24, R2:48, R5:96 }[legKey] || Infinity)).length;
  const rightBeyond = rightOpen.filter(leg => finite(leg.holdingBars) > ({ R1:24, R2:48, R5:96 }[legKey] || Infinity)).length;
  const leftP50 = percentile(leftAges, 0.5), rightP50 = percentile(rightAges, 0.5);
  const leftP90 = percentile(leftAges, 0.9), rightP90 = percentile(rightAges, 0.9);
  const leftMax = leftAges.length ? Math.max(...leftAges) : null;
  const rightMax = rightAges.length ? Math.max(...rightAges) : null;
  return {
    leftOpenClusterCount:leftOpen.length,
    rightOpenClusterCount:rightOpen.length,
    openCountDifference:rightOpen.length - leftOpen.length,
    openCountReductionRate:leftOpen.length > 0 ? round((leftOpen.length - rightOpen.length) / leftOpen.length) : null,
    leftOpenAgeP50:leftP50,
    rightOpenAgeP50:rightP50,
    openAgeP50Difference:Number.isFinite(leftP50) && Number.isFinite(rightP50) ? round(rightP50 - leftP50, 6) : null,
    leftOpenAgeP90:leftP90,
    rightOpenAgeP90:rightP90,
    openAgeP90Difference:Number.isFinite(leftP90) && Number.isFinite(rightP90) ? round(rightP90 - leftP90, 6) : null,
    leftOpenAgeMaximum:leftMax,
    rightOpenAgeMaximum:rightMax,
    openAgeMaximumDifference:Number.isFinite(leftMax) && Number.isFinite(rightMax) ? rightMax - leftMax : null,
    leftOpenBeyondTimeStopCount:leftBeyond,
    rightOpenBeyondTimeStopCount:rightBeyond,
    openBeyondTimeStopDifference:rightBeyond - leftBeyond,
    leftTimeStopExitCount:leftTimeStops,
    rightTimeStopExitCount:rightTimeStops,
    timeStopExitCountDifference:rightTimeStops - leftTimeStops,
  };
}

function rekeyComparisonRows(engine, rows, outcomes, taxonomySummary) {
  return (rows || []).map(row => {
    const scopeKey = `${row.scopeType}|${row.scopeId}`;
    const scope = taxonomySummary.byScope[scopeKey] || emptyScopeTaxonomy();
    const blockers = (row.reviewBlockers || []).filter(blocker => blocker !== 'CLUSTER_MEMBER_OR_SOURCE_DIVERGENCE_PRESENT');
    if (scope.unresolvedEconomicDivergenceCount > 0) blockers.push('UNRESOLVED_ECONOMIC_DIVERGENCE_PRESENT');
    const uniqueBlockers = unique(blockers);
    let state = row.pairedClusterCount >= 30 ? 'SCREENING_ONLY' : 'INSUFFICIENT_PAIRED_EVIDENCE';
    if (uniqueBlockers.length === 0) state = 'STEP7_REVIEW_ELIGIBLE_NO_AUTOMATIC_PROMOTION';
    const tail = row.comparisonKind === 'EXIT_POLICY' ? openTailMetrics.call(engine, outcomes, row) : {};
    return {
      ...row,
      openTailDifferenceDeprecated:row.openTailDifference,
      openTailDifference:undefined,
      ...tail,
      sourceDivergenceCountHistoricalTotal:scope.sourceDivergenceCountHistoricalTotal,
      historicalReplayVarianceDiagnosticOnlyCount:scope.historicalReplayVarianceDiagnosticOnlyCount,
      economicSourceDivergenceCount:scope.economicSourceDivergenceCount,
      excludedClusterCount:scope.permanentlyExcludedClusterCount,
      permanentlyExcludedClusterCount:scope.permanentlyExcludedClusterCount,
      temporarilyQuarantinedClusterCount:scope.temporarilyQuarantinedClusterCount,
      preQuarantineEligibleClusterCount:scope.preQuarantineEligibleClusterCount,
      temporaryQuarantineShare:scope.temporaryQuarantineShare,
      temporaryQuarantineThreshold:scope.temporaryQuarantineThreshold,
      temporaryQuarantineWatchActive:scope.temporaryQuarantineWatchActive,
      unresolvedEconomicDivergenceCount:scope.unresolvedEconomicDivergenceCount,
      reviewBlockers:uniqueBlockers,
      state,
      promotionEligibleFromThisLayer:false,
    };
  });
}

function filterRows(rows, params, fields) {
  return (rows || []).filter(row => fields.every(field => {
    const value = getParam(params, field);
    return value == null || value === '' || String(row[field]) === String(value);
  }));
}

function paginateRows(rows, params) {
  const page = clampInt(getParam(params, 'page'), 1, Number.MAX_SAFE_INTEGER, 1);
  const pageSize = clampInt(getParam(params, 'pageSize'), 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const effectivePage = Math.min(page, totalPages);
  const start = (effectivePage - 1) * pageSize;
  return {
    rows:rows.slice(start, start + pageSize),
    pagination:{
      page:effectivePage,
      pageSize,
      totalRows,
      totalPages,
      hasNextPage:effectivePage < totalPages,
      hasPreviousPage:effectivePage > 1,
    },
  };
}

function compactSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  return {
    schema:snapshot.schema,
    serviceVersion:snapshot.serviceVersion,
    shadowPolicyEngineVersion:snapshot.shadowPolicyEngineVersion,
    candidateEngineVersion:snapshot.candidateEngineVersion,
    snapshotId:snapshot.snapshotId,
    snapshotAt:snapshot.snapshotAt,
    experimentEpochAt:snapshot.experimentEpochAt,
    policyHash:snapshot.policyHash,
    inputFingerprint:snapshot.inputFingerprint,
    baseClustersObserved:snapshot.baseClustersObserved,
    controlParityStatus:snapshot.controlParityStatus,
    temporalIntegrity:snapshot.temporalIntegrity,
    armScoreCount:Array.isArray(snapshot.armScores) ? snapshot.armScores.length : 0,
    comparisonCount:Array.isArray(snapshot.comparisons) ? snapshot.comparisons.length : 0,
    diagnosticsSummary:{
      sourceDivergenceTaxonomy:snapshot.diagnostics && snapshot.diagnostics.sourceDivergenceTaxonomy || null,
    },
    paperOnly:true,
    executionEnabled:false,
    liveCapitalExecution:false,
    promotionEnabled:false,
  };
}

class PolicyShadowEngine extends prior.PolicyShadowEngine {
  constructor(options) {
    super(options);
    const root = path.resolve(options.config.dataRoot);
    this.files.classifications = path.join(root, 'evidence', 'source-divergence-classification-v12073.ndjson');
    this.files.exclusions = path.join(root, 'evidence', 'source-divergence-exclusions-v12073.ndjson');
    this.files.taxonomy = path.join(root, 'manifests', 'source-divergence-taxonomy-v12073.json');
    this.files.classifierCheckpoint = path.join(root, 'state', 'source-divergence-classifier-checkpoint-v12073.json');
    this.classificationEventKeys = new Set();
    this.pendingClassificationEvents = [];
    this.latestFullSnapshot = null;
    this.latestTaxonomySummary = null;
    this.witnessRevisionRecordsByFrame = new Map();
    this.currentWitnessClassifications = [];
    this.legacySourceDivergenceCountHistoricalTotal = 0;
    this.memoryGuards = {
      productionHeapLimitMb:round(v8.getHeapStatistics().heap_size_limit / 1048576, 2),
      containerMemoryLimitMb:finite(process.env.ALPS_CONTAINER_MEMORY_LIMIT_MB),
      rssSoftLimitMb:finite(process.env.ALPS_RSS_SOFT_LIMIT_MB) || 420,
      rssHardLimitMb:finite(process.env.ALPS_RSS_HARD_LIMIT_MB) || 480,
      minimumNativeHeadroomMb:finite(process.env.ALPS_MINIMUM_NATIVE_HEADROOM_MB) || 32,
      memoryGuardState:'READY',
      memoryGuardDeferrals:0,
      lastMemoryGuardDeferralAt:null,
      lastMemoryGuardReason:null,
    };
    this.reportingMetrics = {
      armsDefaultPayloadBytes:null,
      comparisonsDefaultPayloadBytes:null,
      classifierRecordsProcessed:0,
      classifierDurationMs:0,
      classifierPeakHeapMb:0,
      classifierPeakRssMb:0,
      policyStateUndefinedMaterializations:0,
      policyStateUndefinedPaths:[],
    };
  }

  async init() {
    const result = await super.init();
    await this.ensureTaxonomyManifest();
    await this.loadClassificationKeys();
    try {
      const tail = await this.storage.readNdjsonTail(this.files.snapshots, 1, 16 * 1024 * 1024);
      if (Array.isArray(tail) && tail.length) {
        this.latestFullSnapshot = tail[0];
        const priorCounts = (tail[0].comparisons || []).map(row => Number(row.sourceDivergenceCount || row.sourceDivergenceCountHistoricalTotal || 0));
        this.legacySourceDivergenceCountHistoricalTotal = priorCounts.length ? Math.max(...priorCounts) : 0;
      }
    } catch (_) {}
    return this.view();
  }


  async loadWitnessAuthority() {
    this.witnessRowsByFrame.clear();
    this.witnessConflictFrames.clear();
    this.witnessOverrideKeys.clear();
    this.witnessRevisionRecordsByFrame.clear();
    this.witnessAuthority.witnessRows = 0;
    this.witnessAuthority.frames = 0;
    this.witnessAuthority.duplicateRows = 0;
    this.witnessAuthority.conflictingRows = 0;
    let input;
    try {
      await fs.promises.access(this.files.ledger);
      input = fs.createReadStream(this.files.ledger, { encoding:'utf8' });
    } catch (_) {
      this.witnessAuthority.loaded = true;
      this.witnessAuthority.loadedAt = iso(this.now());
      return;
    }
    const rl = readline.createInterface({ input, crlfDelay:Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch (_) { continue; }
      if (event.schema !== 'alps.gen2.policyShadowCandleWitness.v12052' || event.type !== 'CANDLE_ROW_WITNESS' || !event.symbolKey || !event.timeframe) continue;
      const intervalMs = finite(event.intervalMs) || 300000;
      const row = normalizeCandleRow(event.row, intervalMs);
      if (!row) continue;
      const frameKey = `${event.symbolKey}|${event.timeframe}`;
      let map = this.witnessRowsByFrame.get(frameKey);
      if (!map) { map = new Map(); this.witnessRowsByFrame.set(frameKey, map); }
      const first = map.get(row.t);
      const rowHash = event.rowHash || stableHash({ symbolKey:event.symbolKey, timeframe:event.timeframe, row:canonicalCandleRow(row) });
      if (!first) {
        map.set(row.t, row);
        this.witnessAuthority.witnessRows++;
      } else {
        const firstHash = stableHash({ symbolKey:event.symbolKey, timeframe:event.timeframe, row:canonicalCandleRow(first) });
        if (firstHash === rowHash || stableHash(canonicalCandleRow(first)) === stableHash(canonicalCandleRow(row))) {
          this.witnessAuthority.duplicateRows++;
        } else {
          this.witnessAuthority.conflictingRows++;
          const rows = this.witnessRevisionRecordsByFrame.get(frameKey) || [];
          rows.push({
            frameKey,
            symbolKey:event.symbolKey,
            timeframe:event.timeframe,
            intervalMs,
            row,
            firstRow:first,
            firstRowHash:firstHash,
            revisedRowHash:rowHash,
            changedFields:candleChangedFields(canonicalCandleRow(first), canonicalCandleRow(row)),
            observedAt:event.observedAt || event.at || null,
          });
          this.witnessRevisionRecordsByFrame.set(frameKey, rows);
        }
      }
      if (event.rowHash) this.state.witnessHashes[event.rowHash] = true;
    }
    this.witnessAuthority.frames = this.witnessRowsByFrame.size;
    this.witnessAuthority.loaded = true;
    this.witnessAuthority.loadedAt = iso(this.now());
    this.witnessAuthority.mode = 'FIRST_COMMITTED_WITNESS_WINS_DUPLICATE_REVISIONS_CLASSIFIED_NOT_FRAME_BLOCKED';
  }

  simulateClusterArmsForCandles(cluster, candles, controlStates, segmentHash) {
    const signalIndex = candles.findIndex(c => c.t === cluster.signalCandleOpenTime);
    if (signalIndex < 0) return null;
    const authority = this.nominationAuthority(cluster, candles, signalIndex);
    if (!authority.valid) return null;
    const controlArm = this.buildControlAnchor(cluster, authority, controlStates, candles, signalIndex, segmentHash);
    const arms = {
      E0_X0:controlArm,
      E0_X1:this.buildE0TimeStopArm(controlArm, cluster, authority, candles, segmentHash),
    };
    for (const def of ARM_DEFS) {
      if (def.experimentArmId === 'E0_X0' || def.experimentArmId === 'E0_X1') continue;
      arms[def.experimentArmId] = this.simulateModelArm({ armDef:def, cluster, authority, candles, signalIndex, segmentHash });
    }
    return arms;
  }

  async processFrameClusters(frameClusters, source, controlStates, controlCutoffMs, witnessEvents) {
    const outcomes = await super.processFrameClusters(frameClusters, source, controlStates, controlCutoffMs, witnessEvents);
    const frameKey = `${frameClusters[0].symbolKey}|${frameClusters[0].timeframe}`;
    const revisions = this.witnessRevisionRecordsByFrame.get(frameKey) || [];
    if (!revisions.length) return outcomes;

    const rowsRaw = await this.storage.readCrypto(this.config.crypto.cleanDir, frameClusters[0].symbolKey, frameClusters[0].timeframe);
    const authoritativeCandles = this.frameCandles(frameClusters[0].symbolKey, frameClusters[0].timeframe, frameClusters[0].intervalMs, rowsRaw, controlCutoffMs);
    const outcomeById = new Map(outcomes.map(outcome => [outcome.baseEvidenceClusterId, outcome]));

    for (const revision of revisions) {
      const revisedCandles = authoritativeCandles.map(row => row.t === revision.row.t ? { ...revision.row } : { ...row });
      const affectedClusterIds = [];
      const scopeKeys = new Set(['GLOBAL|GLOBAL']);
      let decisionChanged = false;
      for (const cluster of frameClusters) {
        const outcome = outcomeById.get(cluster.baseEvidenceClusterId);
        if (!outcome || outcome.sourceStatus !== 'PASS' || !outcome.arms) continue;
        const revisedArms = this.simulateClusterArmsForCandles(cluster, revisedCandles, controlStates, outcome.candleWitnessSegmentHash || stableHash({ frameKey, revision:revision.revisedRowHash }));
        if (!revisedArms) {
          decisionChanged = true;
          affectedClusterIds.push(cluster.baseEvidenceClusterId);
          for (const key of scopeKeysForOutcome(this, outcome)) scopeKeys.add(key);
          outcome.sourceStatus = 'CLASS_C_DECISION_CHANGING_EXCLUSION_VERIFIED';
          outcome.sourceDivergence = unique([...(outcome.sourceDivergence || []), 'WITNESS_REVISION_RECOMPUTE_CHANGED_OR_UNAVAILABLE']);
          continue;
        }
        const armIds = unique([...Object.keys(outcome.arms), ...Object.keys(revisedArms)]);
        const equal = armIds.every(armId => {
          if (!outcome.arms[armId] || !revisedArms[armId]) return false;
          const authoritativeVector = canonicalPolicyStateVectorFromEngineState(outcome.arms[armId]);
          const revisedVector = canonicalPolicyStateVectorFromEngineState(revisedArms[armId]);
          const undefinedPaths = [...authoritativeVector.undefinedMaterializationPaths, ...revisedVector.undefinedMaterializationPaths];
          this.reportingMetrics.policyStateUndefinedMaterializations += undefinedPaths.length;
          if (undefinedPaths.length) {
            this.reportingMetrics.policyStateUndefinedPaths = unique([
              ...this.reportingMetrics.policyStateUndefinedPaths,
              ...undefinedPaths,
            ]).slice(0, 64);
          }
          return authoritativeVector.canonicalPolicyStateHash === revisedVector.canonicalPolicyStateHash;
        });
        if (!equal) {
          decisionChanged = true;
          affectedClusterIds.push(cluster.baseEvidenceClusterId);
          for (const key of scopeKeysForOutcome(this, outcome)) scopeKeys.add(key);
          outcome.sourceStatus = 'CLASS_C_DECISION_CHANGING_EXCLUSION_VERIFIED';
          outcome.sourceDivergence = unique([...(outcome.sourceDivergence || []), 'WITNESS_REVISION_DECISION_CHANGING']);
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
    }
    rowsRaw.length = 0;
    authoritativeCandles.length = 0;
    return outcomes;
  }

  async ensureTaxonomyManifest() {
    const existing = await this.storage.readJson(this.files.taxonomy, null).catch(() => null);
    const manifest = { ...TAXONOMY_MANIFEST_BODY, taxonomyHash:TAXONOMY_HASH, createdAt:existing && existing.createdAt || iso(this.now()) };
    if (existing) {
      if (existing.taxonomyHash !== TAXONOMY_HASH) throw new Error('SOURCE_DIVERGENCE_TAXONOMY_HASH_MISMATCH');
      return;
    }
    const { done } = this.persistQueue.enqueue(this.files.taxonomy, manifest, { durable:true });
    const persisted = await done;
    if (!persisted || persisted.ok === false) throw new Error(`SOURCE_DIVERGENCE_TAXONOMY_PERSIST_FAILED:${persisted && persisted.error || 'unknown'}`);
  }

  async loadClassificationKeys() {
    this.classificationEventKeys.clear();
    let input;
    try {
      await fs.promises.access(this.files.classifications);
      input = fs.createReadStream(this.files.classifications, { encoding:'utf8' });
    } catch (_) { return; }
    const rl = readline.createInterface({ input, crlfDelay:Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event && event.classificationEventKey) this.classificationEventKeys.add(event.classificationEventKey);
      } catch (_) {}
    }
  }

  async persistState() {
    const full = this.state.latestSnapshot;
    if (full && Array.isArray(full.armScores)) this.state.latestSnapshot = compactSnapshot(full);
    try { return await super.persistState(); }
    finally { this.state.latestSnapshot = full; }
  }

  comparisons(outcomes, context = {}) {
    const taxonomy = buildTaxonomySummary(this, outcomes, iso(this.now()));
    for (const event of this.currentWitnessClassifications) {
      taxonomy.events.push(event);
      taxonomy.sourceDivergenceCountHistoricalTotal = Math.max(taxonomy.sourceDivergenceCountHistoricalTotal, this.legacySourceDivergenceCountHistoricalTotal);
      if (event.terminalClass === 'C_DECISION_CHANGING') {
        taxonomy.economicSourceDivergenceCount++;
        taxonomy.permanentlyExcludedClusterCount += event.affectedClusterIds.length;
      }
      for (const key of event.scopeKeys || ['GLOBAL|GLOBAL']) {
        const scope = ensureScope(taxonomy, key);
        scope.sourceDivergenceCountHistoricalTotal = Math.max(scope.sourceDivergenceCountHistoricalTotal, key === 'GLOBAL|GLOBAL' ? this.legacySourceDivergenceCountHistoricalTotal : scope.sourceDivergenceCountHistoricalTotal);
        if (event.terminalClass === 'C_DECISION_CHANGING') {
          scope.economicSourceDivergenceCount++;
          scope.permanentlyExcludedClusterCount += event.affectedClusterIds.length;
          scope.divergenceByClass.C_decisionChanging++;
        } else {
          scope.divergenceByClass.C_noChange++;
        }
      }
    }
    taxonomy.sourceDivergenceCountHistoricalTotal = Math.max(taxonomy.sourceDivergenceCountHistoricalTotal, this.legacySourceDivergenceCountHistoricalTotal);
    this.latestTaxonomySummary = taxonomy;
    const pendingByKey = new Map();
    for (const event of taxonomy.events) if (!this.classificationEventKeys.has(event.classificationEventKey)) pendingByKey.set(event.classificationEventKey, event);
    this.pendingClassificationEvents = [...pendingByKey.values()];
    const rows = super.comparisons(outcomes, context);
    return rekeyComparisonRows(this, rows, outcomes, taxonomy);
  }

  diagnostics(outcomes, armScores) {
    const base = super.diagnostics(outcomes, armScores);
    const taxonomy = this.latestTaxonomySummary || buildTaxonomySummary(this, outcomes, iso(this.now()));
    return {
      ...base,
      integrityPatchVersion:INTEGRITY_PATCH_VERSION,
      taxonomyHash:TAXONOMY_HASH,
      classificationAlgorithmVersion:CLASSIFICATION_ALGORITHM_VERSION,
      sourceDivergenceTaxonomy:{
        sourceDivergenceCountHistoricalTotal:taxonomy.sourceDivergenceCountHistoricalTotal,
        historicalReplayVarianceDiagnosticOnlyCount:taxonomy.historicalReplayVarianceDiagnosticOnlyCount,
        economicSourceDivergenceCount:taxonomy.economicSourceDivergenceCount,
        unresolvedEconomicDivergenceCount:taxonomy.unresolvedEconomicDivergenceCount,
        permanentlyExcludedClusterCount:taxonomy.permanentlyExcludedClusterCount,
        temporarilyQuarantinedClusterCount:taxonomy.temporarilyQuarantinedClusterCount,
        legacyLinkedExcludedCount:taxonomy.legacyLinkedExcludedCount,
        legacyUnlinkedDiagnosticCount:taxonomy.legacyUnlinkedDiagnosticCount,
        postPatchUnclassifiableBlockingCount:taxonomy.postPatchUnclassifiableBlockingCount,
        temporaryQuarantineThreshold:QUARANTINE_WATCH_THRESHOLD,
        temporaryQuarantineWatchActive:Object.values(taxonomy.byScope).some(scope => scope.temporaryQuarantineWatchActive),
        classificationEventCount:taxonomy.events.length,
      },
    };
  }

  async flushClassificationEvents() {
    const rows = [...new Map(this.pendingClassificationEvents.filter(event => !this.classificationEventKeys.has(event.classificationEventKey)).map(event => [event.classificationEventKey, event])).values()];
    if (!rows.length) return;
    const started = Date.now();
    const before = process.memoryUsage();
    const { done } = this.persistQueue.enqueueAppend(this.files.classifications, rows, { durable:true });
    const result = await done;
    if (!result || result.ok === false) throw new Error(`SOURCE_DIVERGENCE_CLASSIFICATION_APPEND_FAILED:${result && result.error || 'unknown'}`);
    for (const event of rows) this.classificationEventKeys.add(event.classificationEventKey);
    this.reportingMetrics.classifierRecordsProcessed += rows.length;
    this.reportingMetrics.classifierDurationMs = Date.now() - started;
    const after = process.memoryUsage();
    this.reportingMetrics.classifierPeakHeapMb = Math.max(this.reportingMetrics.classifierPeakHeapMb, round(Math.max(before.heapUsed, after.heapUsed) / 1048576, 2));
    this.reportingMetrics.classifierPeakRssMb = Math.max(this.reportingMetrics.classifierPeakRssMb, round(Math.max(before.rss, after.rss) / 1048576, 2));
    this.pendingClassificationEvents = [];
  }

  async run(reason = 'scheduled') {
    const rssMb = process.memoryUsage().rss / 1048576;
    if (!this.inFlight && rssMb > this.memoryGuards.rssSoftLimitMb) {
      this.memoryGuards.memoryGuardState = 'MEMORY_SOFT_GUARD_CYCLE_DEFERRED';
      this.memoryGuards.memoryGuardDeferrals++;
      this.memoryGuards.lastMemoryGuardDeferralAt = iso(this.now());
      this.memoryGuards.lastMemoryGuardReason = 'MEMORY_SOFT_GUARD_CYCLE_DEFERRED';
      return this.view();
    }
    this.memoryGuards.memoryGuardState = 'READY';
    this.currentWitnessClassifications = [];
    const result = await super.run(reason);
    if (this.state.latestSnapshot && Array.isArray(this.state.latestSnapshot.armScores)) this.latestFullSnapshot = this.state.latestSnapshot;
    await this.flushClassificationEvents();
    this.state.integrityPatchVersion = INTEGRITY_PATCH_VERSION;
    this.state.taxonomyHash = TAXONOMY_HASH;
    this.state.classificationAlgorithmVersion = CLASSIFICATION_ALGORITHM_VERSION;
    this.state.sourceDivergenceTaxonomy = this.latestTaxonomySummary ? {
      sourceDivergenceCountHistoricalTotal:this.latestTaxonomySummary.sourceDivergenceCountHistoricalTotal,
      historicalReplayVarianceDiagnosticOnlyCount:this.latestTaxonomySummary.historicalReplayVarianceDiagnosticOnlyCount,
      economicSourceDivergenceCount:this.latestTaxonomySummary.economicSourceDivergenceCount,
      unresolvedEconomicDivergenceCount:this.latestTaxonomySummary.unresolvedEconomicDivergenceCount,
      permanentlyExcludedClusterCount:this.latestTaxonomySummary.permanentlyExcludedClusterCount,
      temporarilyQuarantinedClusterCount:this.latestTaxonomySummary.temporarilyQuarantinedClusterCount,
    } : null;
    await this.persistState();
    return this.view();
  }

  snapshotForViews() {
    if (this.latestFullSnapshot && Array.isArray(this.latestFullSnapshot.armScores)) return this.latestFullSnapshot;
    if (this.state.latestSnapshot && Array.isArray(this.state.latestSnapshot.armScores)) return this.state.latestSnapshot;
    return null;
  }

  armsView(params = null) {
    const snapshot = this.snapshotForViews();
    const filtered = filterRows(snapshot && snapshot.armScores || [], params, [
      'scopeType', 'scopeId', 'experimentArmId', 'entryModelVersion', 'exitPolicyVersion',
    ]);
    const { rows:pageRows, pagination } = paginateRows(filtered, params);
    const requestedLeg = getParam(params, 'leg');
    const rows = requestedLeg ? pageRows.map(row => ({ ...row, legs:row.legs && row.legs[requestedLeg] ? { [requestedLeg]:row.legs[requestedLeg] } : {} })) : pageRows;
    const body = {
      schema:'alps.gen2.policyShadowArms.v12073',
      serviceVersion:SERVICE_VERSION,
      integrityPatchVersion:INTEGRITY_PATCH_VERSION,
      generatedFromSnapshotAt:snapshot && snapshot.snapshotAt || this.state.lastSnapshotAt,
      experimentEpochAt:this.state.experimentEpochAt,
      filters:Object.fromEntries(['scopeType','scopeId','experimentArmId','entryModelVersion','exitPolicyVersion','leg'].map(key => [key, getParam(params, key)]).filter(([, value]) => value != null && value !== '')),
      pagination,
      arms:rows,
      paperOnly:true,
      promotionEnabled:false,
    };
    body.payloadBytes = payloadBytes(body);
    this.reportingMetrics.armsDefaultPayloadBytes = body.payloadBytes;
    return body;
  }

  comparisonsView(params = null) {
    const snapshot = this.snapshotForViews();
    let filtered = filterRows(snapshot && snapshot.comparisons || [], params, [
      'scopeType', 'scopeId', 'comparisonId', 'comparisonKind', 'leftArm', 'rightArm', 'leg', 'state',
    ]);
    const blocker = getParam(params, 'reviewBlocker');
    if (blocker) filtered = filtered.filter(row => (row.reviewBlockers || []).includes(blocker));
    const includeDiagnostics = boolParam(params, 'includeDiagnostics', false);
    const { rows, pagination } = paginateRows(filtered, params);
    const body = {
      schema:'alps.gen2.policyShadowComparisons.v12073',
      serviceVersion:SERVICE_VERSION,
      integrityPatchVersion:INTEGRITY_PATCH_VERSION,
      generatedFromSnapshotAt:snapshot && snapshot.snapshotAt || this.state.lastSnapshotAt,
      filters:Object.fromEntries(['scopeType','scopeId','comparisonId','comparisonKind','leftArm','rightArm','leg','state','reviewBlocker'].map(key => [key, getParam(params, key)]).filter(([, value]) => value != null && value !== '')),
      pagination,
      comparisons:rows,
      pairing:'INTENTION_TO_TREAT_OPPORTUNITY_R_PRIMARY',
      promotionEligibleFromThisLayer:false,
    };
    if (includeDiagnostics) body.diagnostics = { sourceDivergenceTaxonomy:this.state.sourceDivergenceTaxonomy || null };
    body.payloadBytes = payloadBytes(body);
    this.reportingMetrics.comparisonsDefaultPayloadBytes = body.payloadBytes;
    return body;
  }

  view() {
    const base = super.view();
    const taxonomy = this.state.sourceDivergenceTaxonomy || {};
    return {
      ...base,
      integrityPatchVersion:INTEGRITY_PATCH_VERSION,
      previousIntegrityPatchVersion:PREVIOUS_INTEGRITY_PATCH_VERSION,
      taxonomyStatus:'FROZEN',
      taxonomyHash:TAXONOMY_HASH,
      classificationAlgorithmVersion:CLASSIFICATION_ALGORITHM_VERSION,
      sourceDivergenceCountHistoricalTotal:Number(taxonomy.sourceDivergenceCountHistoricalTotal || 0),
      historicalReplayVarianceDiagnosticOnlyCount:Number(taxonomy.historicalReplayVarianceDiagnosticOnlyCount || 0),
      economicSourceDivergenceCount:Number(taxonomy.economicSourceDivergenceCount || 0),
      unresolvedEconomicDivergenceCount:Number(taxonomy.unresolvedEconomicDivergenceCount || 0),
      permanentlyExcludedClusterCount:Number(taxonomy.permanentlyExcludedClusterCount || 0),
      temporarilyQuarantinedClusterCount:Number(taxonomy.temporarilyQuarantinedClusterCount || 0),
      memoryGuards:{ ...this.memoryGuards },
      reportingMetrics:{ ...this.reportingMetrics },
      policyStateCanonicalization:{
        schemaVersion:POLICY_STATE_SCHEMA_VERSION,
        source:'FULL_POLICY_ARM_STATE_OBJECT_WITH_FROZEN_METADATA_EXCLUSIONS',
        undefinedHandling:'ENGINE_BOUNDARY_MATERIALIZE_OWN_UNDEFINED_AS_EXPLICIT_NULL_STRICT_CANONICALIZER_REMAINS_FAIL_CLOSED',
        undefinedMaterializationCount:Number(this.reportingMetrics.policyStateUndefinedMaterializations || 0),
        undefinedMaterializationPaths:[...(this.reportingMetrics.policyStateUndefinedPaths || [])],
        metadataExclusionHash:stableHash([...POLICY_STATE_METADATA_EXCLUSIONS].sort()),
      },
    };
  }

  diagnosticsView() {
    const snapshot = this.snapshotForViews();
    return {
      schema:'alps.gen2.policyShadowDiagnostics.v12073',
      serviceVersion:SERVICE_VERSION,
      integrityPatchVersion:INTEGRITY_PATCH_VERSION,
      generatedFromSnapshotAt:snapshot && snapshot.snapshotAt || this.state.lastSnapshotAt,
      diagnostics:snapshot && snapshot.diagnostics || {},
      controlParityStatus:this.state.controlParityStatus,
      taxonomyHash:TAXONOMY_HASH,
    };
  }

  manifestView() {
    return {
      policy:super.manifestView(),
      sourceDivergenceTaxonomy:{ ...TAXONOMY_MANIFEST_BODY, taxonomyHash:TAXONOMY_HASH },
    };
  }
}

module.exports = {
  ...prior,
  PolicyShadowEngine,
  INTEGRITY_PATCH_VERSION,
  PREVIOUS_INTEGRITY_PATCH_VERSION,
  CLASSIFICATION_ALGORITHM_VERSION,
  TAXONOMY_HASH,
  TAXONOMY_MANIFEST_BODY,
  POLICY_STATE_SCHEMA_VERSION,
  QUARANTINE_WATCH_THRESHOLD,
  QUARANTINE_WATCH_MIN_SCOPE_N,
  materializePolicyState,
  canonicalPolicyStateVector,
  canonicalPolicyStateVectorFromEngineState,
  buildTaxonomySummary,
  rekeyComparisonRows,
  paginateRows,
  compactSnapshot,
};
