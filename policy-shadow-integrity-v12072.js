'use strict';

const fs = require('fs');
const readline = require('readline');
const prior = require('./policy-shadow-integrity-v12071');

const {
  SERVICE_VERSION,
  SHADOW_VERSION,
  CONTROL_VERSION,
  ENTRY_MODELS,
  EXIT_POLICIES,
  ARM_DEFS,
  stableHash,
  deriveSetupAtSignal,
  simulateExit,
  riskGeometry,
} = prior;

const INTEGRITY_PATCH_VERSION = 'v12.0.7.2-witness-authority-control-anchor';
const PREVIOUS_INTEGRITY_PATCH_VERSION = prior.INTEGRITY_PATCH_VERSION;
const RR_LEGS = Object.freeze([1, 2, 5]);
const CANDLE_WITNESS_SCHEMA = 'alps.gen2.policyShadowCandleWitness.v12052';
const ARM_SCHEMA = 'alps.gen2.entryExitPolicyArmOutcome.v12052';
const OUTCOME_SCHEMA = 'alps.gen2.entryExitPolicyClusterOutcome.v12052';
const E0_ZONE_ATR = 0.15;

function iso(value = Date.now()) { return new Date(value).toISOString(); }
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function parseMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = Date.parse(String(value));
  return Number.isFinite(n) ? n : null;
}
function round(value, digits = 8) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
}
function roundPrice(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toPrecision(12)) : null;
}
function unique(values) { return [...new Set((values || []).filter(v => v != null && v !== ''))].sort(); }
function directionSign(direction) { return direction === 'LONG' ? 1 : direction === 'SHORT' ? -1 : 0; }
function parseHypothesis(hypothesisId) {
  const m = /^CRYPTO-([^-]+)-([^-]+)-(.+)$/.exec(String(hypothesisId || ''));
  return m ? { symbolKey:m[1], timeframe:m[2], family:m[3] } : { symbolKey:null, timeframe:null, family:null };
}
function priceEqual(left, right) {
  const a = finite(left), b = finite(right);
  if (a == null || b == null) return a === b;
  const tolerance = Math.max(1e-9, Math.max(Math.abs(a), Math.abs(b), 1) * 2e-11);
  return Math.abs(a - b) <= tolerance;
}
function normalizeCandle(row, intervalMs) {
  if (!row || typeof row !== 'object') return null;
  const t = finite(row.t ?? row.openTime ?? row.time ?? row.timestamp);
  const c = {
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
  return validCandle(c) ? c : null;
}
function validCandle(c) {
  return !!c && Number.isFinite(c.t) && [c.o, c.h, c.l, c.c].every(n => Number.isFinite(n) && n > 0) &&
    c.h >= c.l && c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c);
}
function candleTR(c, priorClose) {
  return !Number.isFinite(priorClose) ? Math.max(0, c.h - c.l) : Math.max(c.h - c.l, Math.abs(c.h - priorClose), Math.abs(c.l - priorClose));
}
function atr(rows, period = 14) {
  if (rows.length < period + 1) return null;
  let sum = 0;
  for (let i = rows.length - period; i < rows.length; i++) sum += candleTR(rows[i], rows[i - 1] && rows[i - 1].c);
  const value = sum / period;
  return Number.isFinite(value) && value > 0 ? value : null;
}
function meanStd(rows, period) {
  const a = rows.slice(-period);
  if (a.length < period) return null;
  const mean = a.reduce((s, c) => s + c.c, 0) / period;
  const variance = a.reduce((s, c) => s + (c.c - mean) ** 2, 0) / period;
  return { mean, std:Math.sqrt(Math.max(0, variance)) };
}
function featureSnapshot(candles, index, direction, family) {
  const rows = candles.slice(0, index + 1);
  const a = atr(rows, 14);
  const ref8 = rows.at(-9) && rows.at(-9).c;
  const ref12 = rows.at(-13) && rows.at(-13).c;
  const stats = meanStd(rows, 20);
  const m8 = ref8 ? rows.at(-1).c / ref8 - 1 : null;
  const m12 = ref12 ? rows.at(-1).c / ref12 - 1 : null;
  const z = stats && stats.std > 0 ? (rows.at(-1).c - stats.mean) / stats.std : null;
  const sign = directionSign(direction);
  return {
    atr:roundPrice(a),
    momentum8:round(m8, 8),
    momentum12:round(m12, 8),
    zScore:round(z, 6),
    signedMomentum8:Number.isFinite(m8) ? round(sign * m8, 8) : null,
    signedMomentum12:Number.isFinite(m12) ? round(sign * m12, 8) : null,
    signedReversionStretch:Number.isFinite(z) ? round(-sign * z, 8) : null,
    family,
  };
}
function canonicalRow(c) {
  return { t:c.t, o:roundPrice(c.o), h:roundPrice(c.h), l:roundPrice(c.l), c:roundPrice(c.c), v:roundPrice(c.v), closeTime:c.closeTime };
}
function excursions(candles, entryIndex, entry, direction, risk, bars) {
  const rows = candles.slice(entryIndex + 1, entryIndex + 1 + bars);
  if (!rows.length || !Number.isFinite(risk) || risk <= 0) return { mfeR:null, maeR:null };
  const fav = direction === 'LONG' ? Math.max(...rows.map(c => c.h - entry)) : Math.max(...rows.map(c => entry - c.l));
  const adv = direction === 'LONG' ? Math.max(...rows.map(c => entry - c.l)) : Math.max(...rows.map(c => c.h - entry));
  return { mfeR:round(fav / risk, 8), maeR:round(adv / risk, 8) };
}
function armLegFromControl(leg, candles, entryIndex) {
  const out = { ...(leg || {}) };
  if (out.status === 'AMBIGUOUS_BOTH_TOUCHED') out.status = 'AMBIGUOUS';
  const exitIndex = out.exitCandleOpenAt ? candles.findIndex(c => iso(c.t) === out.exitCandleOpenAt) : -1;
  out.holdingBars = exitIndex >= 0 && entryIndex >= 0 ? Math.max(0, exitIndex - entryIndex) : Math.max(0, candles.length - entryIndex - 1);
  out.closedAt = out.exitCandleCloseAt || null;
  return out;
}
function controlDisposition(state) {
  if (!state) return 'UNKNOWN';
  if (state.status === 'OPEN_PAPER' || state.status === 'CLOSED_PAPER') return 'ENTERED';
  if (state.status === 'EXPIRED') return 'EXPIRED';
  if (state.status === 'PENDING_FORWARD_ENTRY') return 'PENDING';
  return 'UNKNOWN';
}
function controlEconomicSignature(state) {
  if (!state || !['OPEN_PAPER', 'CLOSED_PAPER'].includes(state.status)) return null;
  return stableHash({
    entry:roundPrice(state.entry),
    initialStop:roundPrice(state.initialStop),
    targets:(state.targets || []).map(x => ({ rr:Number(x.rr), target:roundPrice(x.target) })).sort((a, b) => a.rr - b.rr),
  });
}
function sourceReplayDiagnostic({ member, candles, signalIndex, cluster, source }) {
  const parsed = parseHypothesis(member.hypothesisId);
  const setup = deriveSetupAtSignal({
    family:parsed.family,
    candles:candles.slice(0, signalIndex + 1),
    symbolKey:cluster.symbolKey,
    symbol:cluster.symbol,
    timeframe:cluster.timeframe,
    intervalMs:cluster.intervalMs,
    epochMs:parseMs(source.inputFingerprint.candidateEngineEpochAt),
  });
  const reasons = [];
  if (!setup.produced) reasons.push(`SETUP_RECONSTRUCTION_FAILED:${setup.reason}`);
  if (setup.signature !== member.setupId) reasons.push('SETUP_ID_MISMATCH');
  if (!priceEqual(setup.initialStop, member.plannedInitialStop)) reasons.push('PLANNED_STOP_MISMATCH');
  if (!priceEqual(setup.entryZoneLow, member.entryZoneLow) || !priceEqual(setup.entryZoneHigh, member.entryZoneHigh)) reasons.push('CONTROL_ZONE_MISMATCH');
  return reasons.length ? {
    candidateId:member.candidateId,
    hypothesisId:member.hypothesisId,
    reasons:unique(reasons),
    diagnosticOnly:true,
    authority:'CERTIFIED_CANDIDATE_NOMINATION_EVENT',
  } : null;
}

class PolicyShadowEngine extends prior.PolicyShadowEngine {
  constructor(options) {
    super(options);
    this.witnessRowsByFrame = new Map();
    this.witnessConflictFrames = new Set();
    this.witnessOverrideKeys = new Set();
    this.witnessAuthority = {
      mode:'FIRST_COMMITTED_CANDLE_ROW_WITNESS_WINS_CURRENT_CLEAN_ROWS_ONLY_EXTEND_TAIL',
      loaded:false,
      loadedAt:null,
      witnessRows:0,
      frames:0,
      duplicateRows:0,
      conflictingRows:0,
      currentRowsOverriddenByWitness:0,
      newWitnessRowsObservedThisProcess:0,
      sourceLedger:this.files.ledger,
    };
  }

  async init() {
    const result = await super.init();
    if (this.ready) await this.loadWitnessAuthority();
    return { ...result, integrityPatchVersion:INTEGRITY_PATCH_VERSION };
  }

  async loadWitnessAuthority() {
    this.witnessRowsByFrame.clear();
    this.witnessConflictFrames.clear();
    this.witnessOverrideKeys.clear();
    this.witnessAuthority.witnessRows = 0;
    this.witnessAuthority.frames = 0;
    this.witnessAuthority.duplicateRows = 0;
    this.witnessAuthority.conflictingRows = 0;
    let input;
    try { input = fs.createReadStream(this.files.ledger, { encoding:'utf8' }); }
    catch (_) { this.witnessAuthority.loaded = true; this.witnessAuthority.loadedAt = iso(this.now()); return; }
    const rl = readline.createInterface({ input, crlfDelay:Infinity });
    try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch (_) { continue; }
      if (event.schema !== CANDLE_WITNESS_SCHEMA || event.type !== 'CANDLE_ROW_WITNESS' || !event.symbolKey || !event.timeframe) continue;
      const intervalMs = finite(event.intervalMs) || 300000;
      const row = normalizeCandle(event.row, intervalMs);
      if (!row) continue;
      const frameKey = `${event.symbolKey}|${event.timeframe}`;
      let map = this.witnessRowsByFrame.get(frameKey);
      if (!map) { map = new Map(); this.witnessRowsByFrame.set(frameKey, map); }
      const priorRow = map.get(row.t);
      if (!priorRow) {
        map.set(row.t, row);
        this.witnessAuthority.witnessRows++;
      } else if (stableHash(canonicalRow(priorRow)) === stableHash(canonicalRow(row))) {
        this.witnessAuthority.duplicateRows++;
      } else {
        this.witnessAuthority.conflictingRows++;
        this.witnessConflictFrames.add(frameKey);
      }
      if (event.rowHash) this.state.witnessHashes[event.rowHash] = true;
    }
    } catch (_) {}
    this.witnessAuthority.frames = this.witnessRowsByFrame.size;
    this.witnessAuthority.loaded = true;
    this.witnessAuthority.loadedAt = iso(this.now());
  }

  groupClusters(nominations) {
    const clusters = super.groupClusters(nominations);
    for (const cluster of clusters) {
      const nominationTimes = cluster.members.map(m => parseMs(m.nominatedAt || m.observedAt)).filter(Number.isFinite);
      cluster.nominatedAtMinMs = nominationTimes.length ? Math.min(...nominationTimes) : cluster.nominatedAtMs;
      cluster.nominatedAtMaxMs = nominationTimes.length ? Math.max(...nominationTimes) : cluster.nominatedAtMs;
      cluster.nominationSpreadMs = Number.isFinite(cluster.nominatedAtMinMs) && Number.isFinite(cluster.nominatedAtMaxMs) ? cluster.nominatedAtMaxMs - cluster.nominatedAtMinMs : null;
      cluster.nominatedAtMs = cluster.nominatedAtMinMs;
      const lows = cluster.members.map(m => roundPrice(m.entryZoneLow));
      const highs = cluster.members.map(m => roundPrice(m.entryZoneHigh));
      if (lows.some(v => !priceEqual(v, lows[0]))) cluster.sourceDivergence.push('ENTRY_ZONE_LOW_DIVERGENCE');
      if (highs.some(v => !priceEqual(v, highs[0]))) cluster.sourceDivergence.push('ENTRY_ZONE_HIGH_DIVERGENCE');
      cluster.sourceDivergence = unique(cluster.sourceDivergence);
    }
    return clusters;
  }

  frameCandles(symbolKey, timeframe, intervalMs, rowsRaw, controlCutoffMs) {
    const frameKey = `${symbolKey}|${timeframe}`;
    const current = new Map();
    for (const raw of rowsRaw || []) {
      const row = normalizeCandle(raw, intervalMs);
      if (row && row.validForSignals !== false) current.set(row.t, row);
    }
    const witness = this.witnessRowsByFrame.get(frameKey) || new Map();
    for (const [t, row] of witness) {
      if (current.has(t) && stableHash(canonicalRow(current.get(t))) !== stableHash(canonicalRow(row))) {
        const overrideKey = `${frameKey}|${t}`;
        if (!this.witnessOverrideKeys.has(overrideKey)) {
          this.witnessOverrideKeys.add(overrideKey);
          this.witnessAuthority.currentRowsOverriddenByWitness++;
        }
      }
      current.set(t, row);
    }
    return [...current.values()]
      .filter(c => c.validForSignals !== false && (!Number.isFinite(controlCutoffMs) || c.closeTime <= controlCutoffMs))
      .sort((a, b) => a.t - b.t);
  }

  nominationAuthority(cluster, candles, signalIndex) {
    const reasons = [...(cluster.sourceDivergence || [])];
    const first = cluster.members[0] || {};
    const low = finite(first.entryZoneLow), high = finite(first.entryZoneHigh), stop = finite(first.plannedInitialStop);
    if (![low, high, stop].every(Number.isFinite) || high <= low) reasons.push('INVALID_CERTIFIED_NOMINATION_GEOMETRY');
    const entry = Number.isFinite(low) && Number.isFinite(high) ? (low + high) / 2 : null;
    const atrValue = Number.isFinite(low) && Number.isFinite(high) ? (high - low) / (2 * E0_ZONE_ATR) : null;
    if (!Number.isFinite(entry) || entry <= 0) reasons.push('INVALID_CERTIFIED_REFERENCE_ENTRY');
    if (!Number.isFinite(atrValue) || atrValue <= 0) reasons.push('INVALID_CERTIFIED_NOMINATION_ATR');
    for (const member of cluster.members) {
      if (!priceEqual(member.entryZoneLow, low) || !priceEqual(member.entryZoneHigh, high)) reasons.push('CERTIFIED_MEMBER_ZONE_DIVERGENCE');
      if (!priceEqual(member.plannedInitialStop, stop)) reasons.push('CERTIFIED_MEMBER_STOP_DIVERGENCE');
      if (!member.setupId) reasons.push('CERTIFIED_SETUP_ID_MISSING');
    }
    const nominationFeaturesByHypothesis = {};
    for (const hypothesisId of cluster.hypothesisIds) {
      const family = parseHypothesis(hypothesisId).family;
      nominationFeaturesByHypothesis[hypothesisId] = { ...featureSnapshot(candles, signalIndex, cluster.direction, family), atr:roundPrice(atrValue) };
    }
    return {
      valid:reasons.length === 0,
      reasons:unique(reasons),
      entry:roundPrice(entry),
      entryZoneLow:roundPrice(low),
      entryZoneHigh:roundPrice(high),
      initialStop:roundPrice(stop),
      features:{ atr:roundPrice(atrValue) },
      nominationFeaturesByHypothesis,
      authority:'CERTIFIED_CANDIDATE_NOMINATION_EVENT',
    };
  }

  enteredDiagnostics({ cluster, authority, candles, entryIndex, entry, riskDistance }) {
    const entryFeaturesByHypothesis = {};
    const adverseSelectionByHypothesis = {};
    for (const hypothesisId of cluster.hypothesisIds) {
      const family = parseHypothesis(hypothesisId).family;
      const nomination = authority.nominationFeaturesByHypothesis[hypothesisId] || {};
      const atEntry = featureSnapshot(candles, entryIndex, cluster.direction, family);
      entryFeaturesByHypothesis[hypothesisId] = atEntry;
      const sign = directionSign(cluster.direction);
      adverseSelectionByHypothesis[hypothesisId] = {
        family,
        momentumDecayBeforeEntry:family === 'TREND_CONTINUATION' && Number.isFinite(atEntry.signedMomentum8) && Number.isFinite(nomination.momentum8)
          ? round(atEntry.signedMomentum8 - sign * nomination.momentum8, 8)
          : family === 'MOMENTUM_REVERSAL' && Number.isFinite(atEntry.signedMomentum12) && Number.isFinite(nomination.momentum12)
            ? round(atEntry.signedMomentum12 - sign * nomination.momentum12, 8)
            : null,
        reversionStretchDecay:family === 'MEAN_REVERSION' && Number.isFinite(atEntry.signedReversionStretch) && Number.isFinite(nomination.zScore)
          ? round(atEntry.signedReversionStretch - (-sign * nomination.zScore), 8)
          : null,
      };
    }
    const e3 = excursions(candles, entryIndex, entry, cluster.direction, riskDistance, 3);
    const e6 = excursions(candles, entryIndex, entry, cluster.direction, riskDistance, 6);
    return {
      nominationFeaturesByHypothesis:authority.nominationFeaturesByHypothesis,
      entryFeaturesByHypothesis,
      adverseSelectionByHypothesis,
      MFE_3_BARS:e3.mfeR,
      MAE_3_BARS:e3.maeR,
      MFE_6_BARS:e6.mfeR,
      MAE_6_BARS:e6.maeR,
    };
  }

  buildControlAnchor(cluster, authority, controlStates, candles, signalIndex, segmentHash) {
    const memberRows = cluster.members.map(member => ({
      member,
      control:controlStates.get(member.candidateId) || null,
    }));
    const unknown = memberRows.filter(row => !row.control);
    const entered = memberRows.filter(row => controlDisposition(row.control) === 'ENTERED');
    const expired = memberRows.filter(row => controlDisposition(row.control) === 'EXPIRED');
    const pending = memberRows.filter(row => controlDisposition(row.control) === 'PENDING');
    const signatures = unique(entered.map(row => controlEconomicSignature(row.control)));
    const parityReasons = [];
    if (unknown.length) parityReasons.push('CONTROL_CANDIDATE_NOT_IN_LEDGER_FOLD');
    if (signatures.length > 1) parityReasons.push('CONTROL_CLUSTER_ENTERED_ECONOMIC_DIVERGENCE');

    const memberTiming = memberRows.map(row => ({
      candidateId:row.member.candidateId,
      hypothesisId:row.member.hypothesisId,
      nominatedAt:row.member.nominatedAt || row.member.observedAt || null,
      controlEntryStatus:controlDisposition(row.control),
      controlDecisionCandleOpenAt:row.control ? (row.control.entryCandleOpenAt || row.control.expiryCandleOpenAt || null) : null,
      controlDecisionCandleCloseAt:row.control ? (row.control.entryCandleCloseAt || row.control.expiryCandleCloseAt || null) : null,
      diagnosticOnly:true,
    }));

    let entryState;
    let anchorCandidateId = null;
    if (entered.length) {
      entered.sort((a, b) => String(a.control.entryCandleCloseAt || '').localeCompare(String(b.control.entryCandleCloseAt || '')) || String(a.member.candidateId).localeCompare(String(b.member.candidateId)));
      const anchor = entered[0];
      anchorCandidateId = anchor.member.candidateId;
      const control = anchor.control;
      const entry = roundPrice(control.entry), stop = roundPrice(control.initialStop), riskDistance = roundPrice(Math.abs(entry - stop));
      const entryIndex = candles.findIndex(c => iso(c.t) === control.entryCandleOpenAt);
      if (entryIndex < 0) parityReasons.push('CONTROL_ENTRY_CANDLE_NOT_IN_WITNESS_AUTHORITY');
      const targets = (control.targets || []).map(t => ({ rr:Number(t.rr), target:roundPrice(t.target) })).filter(t => RR_LEGS.includes(t.rr)).sort((a, b) => a.rr - b.rr);
      const legs = {};
      for (const rr of RR_LEGS) legs[`R${rr}`] = armLegFromControl(control.legs && control.legs[`R${rr}`], candles, entryIndex);
      const geometry = riskGeometry({ entry, stop, direction:cluster.direction, atrValue:authority.features.atr });
      if (!geometry.valid && geometry.validSide && Number.isFinite(geometry.entryRiskDistanceATR) && geometry.entryRiskDistanceATR < 0.25) {
        entryState = {
          entryStatus:'INVALID_RISK_DISTANCE', resolved:true, entered:false, expired:false, invalidRiskDistance:true,
          entry, initialStop:stop, entryRiskDistanceATR:geometry.entryRiskDistanceATR,
          invalidReason:'RISK_DISTANCE_BELOW_025_ATR',
          entryCandleOpenAt:control.entryCandleOpenAt, entryCandleCloseAt:control.entryCandleCloseAt,
          entryDelayBars:entryIndex >= 0 ? Math.max(1, entryIndex - signalIndex) : null,
          entryZoneLow:authority.entryZoneLow, entryZoneHigh:authority.entryZoneHigh,
        };
      } else {
        entryState = {
          entryStatus:'ENTERED', resolved:true, entered:true, expired:false, invalidRiskDistance:false,
          entry, initialStop:stop, riskDistance, entryRiskDistanceATR:geometry.entryRiskDistanceATR,
          targets, entryZoneLow:authority.entryZoneLow, entryZoneHigh:authority.entryZoneHigh,
          entryCandleOpenAt:control.entryCandleOpenAt, entryCandleCloseAt:control.entryCandleCloseAt,
          entryIndex, entryDelayBars:entryIndex >= 0 ? Math.max(1, entryIndex - signalIndex) : null,
          entryDistanceFromReferenceATR:Number.isFinite(authority.features.atr) ? round(Math.abs(entry - authority.entry) / authority.features.atr, 8) : null,
          signedEntryDriftATR:Number.isFinite(authority.features.atr) ? round(directionSign(cluster.direction) * (entry - authority.entry) / authority.features.atr, 8) : null,
          ...this.enteredDiagnostics({ cluster, authority, candles, entryIndex, entry, riskDistance }),
          legs,
        };
      }
    } else if (!unknown.length && expired.length === memberRows.length) {
      expired.sort((a, b) => String(a.control.expiryCandleCloseAt || '').localeCompare(String(b.control.expiryCandleCloseAt || '')) || String(a.member.candidateId).localeCompare(String(b.member.candidateId)));
      const anchor = expired.at(-1);
      anchorCandidateId = anchor.member.candidateId;
      entryState = {
        entryStatus:'EXPIRED', resolved:true, entered:false, expired:true, invalidRiskDistance:false,
        expiryReason:'ENTRY_ZONE_EXPIRED_BEFORE_FORWARD_ENTRY',
        entryZoneLow:authority.entryZoneLow, entryZoneHigh:authority.entryZoneHigh,
        expiryCandleOpenAt:anchor.control.expiryCandleOpenAt,
        expiryCandleCloseAt:anchor.control.expiryCandleCloseAt,
        observedClose:null,
      };
    } else {
      entryState = {
        entryStatus:'PENDING', resolved:false, entered:false, expired:false, invalidRiskDistance:false,
        entryZoneLow:authority.entryZoneLow, entryZoneHigh:authority.entryZoneHigh,
        eligibleCandlesObserved:null,
      };
      anchorCandidateId = pending[0] && pending[0].member.candidateId || unknown[0] && unknown[0].member.candidateId || null;
    }

    const arm = {
      schema:ARM_SCHEMA,
      experimentArmId:'E0_X0',
      entryModelVersion:ENTRY_MODELS.E0.entryModelVersion,
      exitPolicyVersion:EXIT_POLICIES.X0.exitPolicyVersion,
      experimentEvidenceClusterId:`${cluster.baseEvidenceClusterId}|${ENTRY_MODELS.E0.entryModelVersion}|${EXIT_POLICIES.X0.exitPolicyVersion}`,
      baseEvidenceClusterId:cluster.baseEvidenceClusterId,
      symbolKey:cluster.symbolKey,
      timeframe:cluster.timeframe,
      direction:cluster.direction,
      signalCandleOpenTime:cluster.signalCandleOpenTime,
      signalCandleOpenAt:iso(cluster.signalCandleOpenTime),
      memberCandidateIds:cluster.members.map(x => x.candidateId),
      memberHypothesisIds:cluster.hypothesisIds,
      families:cluster.families,
      referenceEntry:authority.entry,
      nominationATR:authority.features.atr,
      plannedInitialStop:authority.initialStop,
      candleWitnessSegmentHash:segmentHash,
      ...entryState,
      controlAnchor:{
        authority:'CERTIFIED_FORWARD_V12051_LEDGER_FOLD',
        anchorCandidateId,
        aggregationRule:'ENTERED_IF_ANY_MEMBER_ENTERED_EXPIRED_ONLY_IF_ALL_MEMBERS_EXPIRED_OTHERWISE_PENDING',
        memberTiming,
      },
      controlParityStatus:parityReasons.length ? (unknown.length ? 'UNKNOWN_CONTROL_STATE' : 'CONTROL_PARITY_DIVERGENCE') : 'PASS',
      controlParityPolicyDomainExclusions:entryState.entryStatus === 'INVALID_RISK_DISTANCE' && entryState.invalidReason === 'RISK_DISTANCE_BELOW_025_ATR' ? [{
        candidateId:anchorCandidateId,
        code:'MINIMUM_ENTRY_RISK_DISTANCE_ATR_GUARD',
        reason:'CERTIFIED_CONTROL_HAS_NO_025_ATR_MINIMUM_WHILE_FROZEN_SHADOW_POLICY_DOES',
        entryRiskDistanceATR:entryState.entryRiskDistanceATR,
        thresholdATR:0.25,
        economicInterpretation:'EXCLUDED_FROM_CONTROL_PARITY_FAILURE_AND_RETAINED_AS_ZERO_OPPORTUNITY_R_BY_FROZEN_ITT_POLICY',
      }] : [],
      controlParity:parityReasons.length ? [{ candidateId:anchorCandidateId, status:unknown.length ? 'UNKNOWN_CONTROL_STATE' : 'CONTROL_PARITY_DIVERGENCE', reasons:unique(parityReasons), memberTiming }] : [],
      paperOnly:true,
      liveCapitalExecution:false,
      promotionEnabled:false,
    };
    return arm;
  }

  buildE0TimeStopArm(controlArm, cluster, authority, candles, segmentHash) {
    let entryState;
    if (controlArm.entryStatus === 'ENTERED') {
      const entryIndex = controlArm.entryIndex >= 0 ? controlArm.entryIndex : candles.findIndex(c => iso(c.t) === controlArm.entryCandleOpenAt);
      entryState = {
        entryStatus:controlArm.entryStatus,
        resolved:controlArm.resolved,
        entered:controlArm.entered,
        expired:controlArm.expired,
        invalidRiskDistance:controlArm.invalidRiskDistance,
        entry:controlArm.entry,
        initialStop:controlArm.initialStop,
        riskDistance:controlArm.riskDistance,
        entryRiskDistanceATR:controlArm.entryRiskDistanceATR,
        targets:controlArm.targets,
        entryZoneLow:controlArm.entryZoneLow,
        entryZoneHigh:controlArm.entryZoneHigh,
        entryCandleOpenAt:controlArm.entryCandleOpenAt,
        entryCandleCloseAt:controlArm.entryCandleCloseAt,
        entryIndex,
        entryDelayBars:controlArm.entryDelayBars,
        entryDistanceFromReferenceATR:controlArm.entryDistanceFromReferenceATR,
        signedEntryDriftATR:controlArm.signedEntryDriftATR,
        nominationFeaturesByHypothesis:controlArm.nominationFeaturesByHypothesis,
        entryFeaturesByHypothesis:controlArm.entryFeaturesByHypothesis,
        adverseSelectionByHypothesis:controlArm.adverseSelectionByHypothesis,
        MFE_3_BARS:controlArm.MFE_3_BARS,
        MAE_3_BARS:controlArm.MAE_3_BARS,
        MFE_6_BARS:controlArm.MFE_6_BARS,
        MAE_6_BARS:controlArm.MAE_6_BARS,
        legs:simulateExit({
          candles,
          entryIndex,
          entry:controlArm.entry,
          stop:controlArm.initialStop,
          direction:cluster.direction,
          targets:controlArm.targets,
          exitPolicy:EXIT_POLICIES.X1,
        }),
      };
    } else {
      entryState = {
        entryStatus:controlArm.entryStatus,
        resolved:controlArm.resolved,
        entered:controlArm.entered,
        expired:controlArm.expired,
        invalidRiskDistance:controlArm.invalidRiskDistance,
        entry:controlArm.entry,
        initialStop:controlArm.initialStop,
        entryRiskDistanceATR:controlArm.entryRiskDistanceATR,
        invalidReason:controlArm.invalidReason,
        entryCandleOpenAt:controlArm.entryCandleOpenAt,
        entryCandleCloseAt:controlArm.entryCandleCloseAt,
        entryDelayBars:controlArm.entryDelayBars,
        entryZoneLow:controlArm.entryZoneLow,
        entryZoneHigh:controlArm.entryZoneHigh,
        expiryReason:controlArm.expiryReason,
        expiryCandleOpenAt:controlArm.expiryCandleOpenAt,
        expiryCandleCloseAt:controlArm.expiryCandleCloseAt,
        observedClose:controlArm.observedClose,
        eligibleCandlesObserved:controlArm.eligibleCandlesObserved,
      };
    }
    return {
      schema:ARM_SCHEMA,
      experimentArmId:'E0_X1',
      entryModelVersion:ENTRY_MODELS.E0.entryModelVersion,
      exitPolicyVersion:EXIT_POLICIES.X1.exitPolicyVersion,
      experimentEvidenceClusterId:`${cluster.baseEvidenceClusterId}|${ENTRY_MODELS.E0.entryModelVersion}|${EXIT_POLICIES.X1.exitPolicyVersion}`,
      baseEvidenceClusterId:cluster.baseEvidenceClusterId,
      symbolKey:cluster.symbolKey,
      timeframe:cluster.timeframe,
      direction:cluster.direction,
      signalCandleOpenTime:cluster.signalCandleOpenTime,
      signalCandleOpenAt:iso(cluster.signalCandleOpenTime),
      memberCandidateIds:cluster.members.map(x => x.candidateId),
      memberHypothesisIds:cluster.hypothesisIds,
      families:cluster.families,
      referenceEntry:authority.entry,
      nominationATR:authority.features.atr,
      plannedInitialStop:authority.initialStop,
      candleWitnessSegmentHash:segmentHash,
      ...entryState,
      entryAnchor:'CERTIFIED_E0_X0_ENTRY_DECISION',
      paperOnly:true,
      liveCapitalExecution:false,
      promotionEnabled:false,
    };
  }

  simulateModelArm({ armDef, cluster, authority, candles, signalIndex, segmentHash }) {
    const model = armDef.entryModel;
    const zoneLow = model.control ? authority.entryZoneLow : roundPrice(authority.entry - model.zoneAtr * authority.features.atr);
    const zoneHigh = model.control ? authority.entryZoneHigh : roundPrice(authority.entry + model.zoneAtr * authority.features.atr);
    const entryEligible = candles.map((c, i) => ({ c, i })).filter(x => x.c.t >= cluster.nominatedAtMinMs && x.c.t > cluster.signalCandleOpenTime);
    const available = entryEligible.slice(0, model.maxEligibleCandles);
    const hit = available.find(x => x.c.c >= zoneLow && x.c.c <= zoneHigh);
    let entryState;
    if (hit) {
      const entry = roundPrice(hit.c.c);
      const geometry = riskGeometry({ entry, stop:authority.initialStop, direction:cluster.direction, atrValue:authority.features.atr });
      if (!geometry.valid) {
        entryState = {
          entryStatus:'INVALID_RISK_DISTANCE', resolved:true, entered:false, expired:false, invalidRiskDistance:true,
          entry, initialStop:authority.initialStop, entryRiskDistanceATR:geometry.entryRiskDistanceATR,
          invalidReason:!geometry.validSide ? 'ENTRY_STOP_SIDE_INVALID' : 'RISK_DISTANCE_BELOW_025_ATR',
          entryCandleOpenAt:iso(hit.c.t), entryCandleCloseAt:iso(hit.c.closeTime), entryDelayBars:available.indexOf(hit) + 1,
          entryZoneLow:zoneLow, entryZoneHigh:zoneHigh,
        };
      } else {
        const targets = RR_LEGS.map(rr => ({ rr, target:roundPrice(cluster.direction === 'LONG' ? entry + geometry.riskDistance * rr : entry - geometry.riskDistance * rr) }));
        entryState = {
          entryStatus:'ENTERED', resolved:true, entered:true, expired:false, invalidRiskDistance:false,
          entry, initialStop:authority.initialStop, riskDistance:geometry.riskDistance, entryRiskDistanceATR:geometry.entryRiskDistanceATR,
          targets, entryZoneLow:zoneLow, entryZoneHigh:zoneHigh,
          entryCandleOpenAt:iso(hit.c.t), entryCandleCloseAt:iso(hit.c.closeTime), entryIndex:hit.i,
          entryDelayBars:available.indexOf(hit) + 1,
          entryDistanceFromReferenceATR:round(Math.abs(entry - authority.entry) / authority.features.atr, 8),
          signedEntryDriftATR:round(directionSign(cluster.direction) * (entry - authority.entry) / authority.features.atr, 8),
          ...this.enteredDiagnostics({ cluster, authority, candles, entryIndex:hit.i, entry, riskDistance:geometry.riskDistance }),
          legs:simulateExit({ candles, entryIndex:hit.i, entry, stop:authority.initialStop, direction:cluster.direction, targets, exitPolicy:armDef.exitPolicy }),
        };
      }
    } else if (available.length >= model.maxEligibleCandles) {
      const last = available.at(-1);
      entryState = {
        entryStatus:'EXPIRED', resolved:true, entered:false, expired:true, invalidRiskDistance:false,
        expiryReason:'ENTRY_ZONE_EXPIRED_BEFORE_FORWARD_ENTRY', entryZoneLow:zoneLow, entryZoneHigh:zoneHigh,
        expiryCandleOpenAt:iso(last.c.t), expiryCandleCloseAt:iso(last.c.closeTime), observedClose:last.c.c,
      };
    } else {
      entryState = {
        entryStatus:'PENDING', resolved:false, entered:false, expired:false, invalidRiskDistance:false,
        entryZoneLow:zoneLow, entryZoneHigh:zoneHigh, eligibleCandlesObserved:available.length,
      };
    }
    return {
      schema:ARM_SCHEMA,
      experimentArmId:armDef.experimentArmId,
      entryModelVersion:model.entryModelVersion,
      exitPolicyVersion:armDef.exitPolicy.exitPolicyVersion,
      experimentEvidenceClusterId:`${cluster.baseEvidenceClusterId}|${model.entryModelVersion}|${armDef.exitPolicy.exitPolicyVersion}`,
      baseEvidenceClusterId:cluster.baseEvidenceClusterId,
      symbolKey:cluster.symbolKey,
      timeframe:cluster.timeframe,
      direction:cluster.direction,
      signalCandleOpenTime:cluster.signalCandleOpenTime,
      signalCandleOpenAt:iso(cluster.signalCandleOpenTime),
      memberCandidateIds:cluster.members.map(x => x.candidateId),
      memberHypothesisIds:cluster.hypothesisIds,
      families:cluster.families,
      referenceEntry:authority.entry,
      nominationATR:authority.features.atr,
      plannedInitialStop:authority.initialStop,
      candleWitnessSegmentHash:segmentHash,
      clusterNominationAnchorAt:iso(cluster.nominatedAtMinMs),
      clusterNominationSpreadMs:cluster.nominationSpreadMs,
      ...entryState,
      paperOnly:true,
      liveCapitalExecution:false,
      promotionEnabled:false,
    };
  }

  async processFrameClusters(frameClusters, source, controlStates, controlCutoffMs, witnessEvents) {
    const symbolKey = frameClusters[0].symbolKey;
    const timeframe = frameClusters[0].timeframe;
    const intervalMs = frameClusters[0].intervalMs;
    const frameKey = `${symbolKey}|${timeframe}`;
    const rowsRaw = await this.storage.readCrypto(this.config.crypto.cleanDir, symbolKey, timeframe);
    const candles = this.frameCandles(symbolKey, timeframe, intervalMs, rowsRaw, controlCutoffMs);
    const outcomes = [];

    if (this.witnessConflictFrames.has(frameKey)) {
      return frameClusters.map(cluster => ({
        baseEvidenceClusterId:cluster.baseEvidenceClusterId,
        sourceStatus:'WITNESS_AUTHORITY_CONFLICT',
        sourceDivergence:['MULTIPLE_COMMITTED_WITNESS_ROWS_FOR_SAME_FRAME_OPEN_TIME'],
        arms:{},
        memberHypothesisIds:cluster.hypothesisIds,
      }));
    }

    const signalIndexes = frameClusters.map(c => candles.findIndex(row => row.t === c.signalCandleOpenTime)).filter(i => i >= 0);
    const witnessStart = signalIndexes.length ? Math.max(0, Math.min(...signalIndexes) - 239) : 0;
    const witnessRows = candles.slice(witnessStart).map(canonicalRow);
    const witnessRowHashes = [];
    let frameWitnessMap = this.witnessRowsByFrame.get(frameKey);
    if (!frameWitnessMap) {
      frameWitnessMap = new Map();
      this.witnessRowsByFrame.set(frameKey, frameWitnessMap);
      this.witnessAuthority.frames = this.witnessRowsByFrame.size;
    }
    for (const row of witnessRows) {
      const rowHash = stableHash({ symbolKey, timeframe, row });
      witnessRowHashes.push(rowHash);
      if (!this.state.witnessHashes[rowHash]) {
        witnessEvents.push({ schema:CANDLE_WITNESS_SCHEMA, serviceVersion:SERVICE_VERSION, shadowPolicyEngineVersion:SHADOW_VERSION, type:'CANDLE_ROW_WITNESS', rowHash, symbolKey, timeframe, intervalMs, row });
        this.state.witnessHashes[rowHash] = true;
        this.witnessAuthority.newWitnessRowsObservedThisProcess++;
      }
      if (!frameWitnessMap.has(row.t)) {
        frameWitnessMap.set(row.t, normalizeCandle(row, intervalMs));
        this.witnessAuthority.witnessRows++;
      }
    }
    const frameSegmentHash = stableHash({
      symbolKey,
      timeframe,
      firstConsumedCandleOpenTime:witnessRows[0] && witnessRows[0].t || null,
      lastConsumedCandleOpenTime:witnessRows.at(-1) && witnessRows.at(-1).t || null,
      consumedCandleCount:witnessRows.length,
      rowHashes:witnessRowHashes,
    });

    for (const cluster of frameClusters) {
      const signalIndex = candles.findIndex(c => c.t === cluster.signalCandleOpenTime);
      if (signalIndex < 0) {
        outcomes.push({
          baseEvidenceClusterId:cluster.baseEvidenceClusterId,
          sourceStatus:'SIGNAL_CANDLE_NOT_FOUND_IN_WITNESS_AUTHORITY',
          sourceDivergence:['SIGNAL_CANDLE_NOT_FOUND_IN_COMMITTED_WITNESS_OR_CURRENT_CLEAN_TAIL'],
          arms:{},
          memberHypothesisIds:cluster.hypothesisIds,
        });
        continue;
      }
      const authority = this.nominationAuthority(cluster, candles, signalIndex);
      if (!authority.valid) {
        outcomes.push({
          baseEvidenceClusterId:cluster.baseEvidenceClusterId,
          sourceStatus:'CERTIFIED_NOMINATION_AUTHORITY_DIVERGENCE',
          sourceDivergence:authority.reasons,
          arms:{},
          memberHypothesisIds:cluster.hypothesisIds,
        });
        continue;
      }

      const sourceReplayVariance = cluster.members.map(member => sourceReplayDiagnostic({ member, candles, signalIndex, cluster, source })).filter(Boolean);
      const controlArm = this.buildControlAnchor(cluster, authority, controlStates, candles, signalIndex, frameSegmentHash);
      const arms = {
        E0_X0:controlArm,
        E0_X1:this.buildE0TimeStopArm(controlArm, cluster, authority, candles, frameSegmentHash),
      };
      for (const def of ARM_DEFS) {
        if (def.experimentArmId === 'E0_X0' || def.experimentArmId === 'E0_X1') continue;
        arms[def.experimentArmId] = this.simulateModelArm({ armDef:def, cluster, authority, candles, signalIndex, segmentHash:frameSegmentHash });
      }
      outcomes.push({
        schema:OUTCOME_SCHEMA,
        baseEvidenceClusterId:cluster.baseEvidenceClusterId,
        symbolKey,
        timeframe,
        direction:cluster.direction,
        signalCandleOpenTime:cluster.signalCandleOpenTime,
        memberHypothesisIds:cluster.hypothesisIds,
        families:cluster.families,
        sourceStatus:'PASS',
        sourceAuthority:'CERTIFIED_NOMINATION_EVENT_PLUS_FIRST_COMMITTED_CANDLE_WITNESS',
        sourceReplayVarianceDiagnosticOnly:sourceReplayVariance,
        candleWitnessSegmentHash:frameSegmentHash,
        lastConsumedCandleCloseAt:witnessRows.at(-1) && witnessRows.at(-1).closeTime || null,
        arms,
      });
    }

    rowsRaw.length = 0;
    candles.length = 0;
    return outcomes;
  }

  diagnostics(outcomes, armScores) {
    const diagnostics = super.diagnostics(outcomes, armScores);
    const replayVariance = [];
    const controlAnchorTimingVariance = [];
    for (const outcome of outcomes || []) {
      for (const row of outcome.sourceReplayVarianceDiagnosticOnly || []) replayVariance.push({ baseEvidenceClusterId:outcome.baseEvidenceClusterId, ...row });
      const anchor = outcome.arms && outcome.arms.E0_X0 && outcome.arms.E0_X0.controlAnchor;
      if (anchor && Array.isArray(anchor.memberTiming) && unique(anchor.memberTiming.map(x => x.controlEntryStatus)).length > 1) {
        controlAnchorTimingVariance.push({ baseEvidenceClusterId:outcome.baseEvidenceClusterId, anchorCandidateId:anchor.anchorCandidateId, memberTiming:anchor.memberTiming, diagnosticOnly:true });
      }
    }
    return {
      ...diagnostics,
      integrityPatchVersion:INTEGRITY_PATCH_VERSION,
      previousIntegrityPatchVersion:PREVIOUS_INTEGRITY_PATCH_VERSION,
      sourceAuthority:{
        nomination:'CERTIFIED_FORWARD_V12051_CANDIDATE_NOMINATED_EVENT',
        candle:'FIRST_COMMITTED_CANDLE_ROW_WITNESS',
        currentCleanRole:'EXTEND_UNWITNESSED_TAIL_ONLY',
        historicalStrategyReplayCanBlock:false,
      },
      witnessAuthority:{ ...this.witnessAuthority, conflictFrames:[...this.witnessConflictFrames].sort() },
      sourceReplayVarianceDiagnosticOnly:replayVariance,
      controlAnchorTimingVarianceDiagnosticOnly:controlAnchorTimingVariance,
    };
  }

  view() {
    return {
      ...super.view(),
      integrityPatchVersion:INTEGRITY_PATCH_VERSION,
      previousIntegrityPatchVersion:PREVIOUS_INTEGRITY_PATCH_VERSION,
      witnessAuthority:{ ...this.witnessAuthority, conflictFrames:[...this.witnessConflictFrames].sort() },
      controlAnchorMode:'CERTIFIED_LEDGER_CLUSTER_FOLD',
      sourceAuthorityMode:'CERTIFIED_NOMINATION_PLUS_FIRST_COMMITTED_WITNESS',
    };
  }

  diagnosticsView() {
    return {
      ...super.diagnosticsView(),
      integrityPatchVersion:INTEGRITY_PATCH_VERSION,
      previousIntegrityPatchVersion:PREVIOUS_INTEGRITY_PATCH_VERSION,
    };
  }
}

module.exports = {
  ...prior,
  PolicyShadowEngine,
  INTEGRITY_PATCH_VERSION,
  PREVIOUS_INTEGRITY_PATCH_VERSION,
};
