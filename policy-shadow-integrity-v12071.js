'use strict';

const base = require('./policy-shadow-v12052');

const INTEGRITY_PATCH_VERSION = 'v12.0.7.1-policy-shadow-integrity-diagnostics';
const RR_LEGS = Object.freeze([1, 2, 5]);

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function unique(values) {
  return [...new Set((values || []).filter(v => v != null && v !== ''))].sort();
}

function priceEqual(left, right) {
  const a = finite(left);
  const b = finite(right);
  if (a == null || b == null) return a === b;
  const tolerance = Math.max(1e-9, Math.max(Math.abs(a), Math.abs(b), 1) * 2e-11);
  return Math.abs(a - b) <= tolerance;
}

function rEqual(left, right) {
  const a = finite(left);
  const b = finite(right);
  if (a == null || b == null) return a === b;
  return Math.abs(a - b) <= 5e-7;
}

function normalizeLegStatus(value) {
  const status = String(value || '').toUpperCase();
  if (status === 'AMBIGUOUS_BOTH_TOUCHED' || status === 'LEG_CLOSED_AMBIGUOUS') return 'AMBIGUOUS';
  return status || null;
}

function normalizeExpiryReason(value) {
  const reason = String(value || '').toUpperCase();
  if (reason === 'ENTRY_STOP_INVALID_AT_FORWARD_ENTRY' || reason === 'ENTRY_RISK_DISTANCE_INVALID_AT_FORWARD_ENTRY') {
    return 'INVALID_ENTRY_RISK_GEOMETRY_NO_ENTRY';
  }
  if (reason === 'ENTRY_ZONE_EXPIRED_BEFORE_FORWARD_ENTRY') return reason;
  return reason || null;
}

function sameEntryWitness(sim, control, reasons) {
  if (!priceEqual(sim.entry, control.entry)) reasons.push('ENTRY_PRICE_DIVERGENCE');
  if (!priceEqual(sim.initialStop, control.initialStop)) reasons.push('INITIAL_STOP_DIVERGENCE');
  if (sim.entryCandleOpenAt !== control.entryCandleOpenAt) reasons.push('ENTRY_CANDLE_OPEN_DIVERGENCE');
  if (sim.entryCandleCloseAt !== control.entryCandleCloseAt) reasons.push('ENTRY_CANDLE_CLOSE_DIVERGENCE');
}

function compareLeg(simLeg, controlLeg, rr) {
  const reasons = [];
  if (!simLeg || !controlLeg) return [`R${rr}_LEG_STATE_MISSING`];

  const simStatus = normalizeLegStatus(simLeg.status);
  const controlStatus = normalizeLegStatus(controlLeg.status);
  if (simStatus !== controlStatus) return [`R${rr}_STATUS_DIVERGENCE`];

  if (!priceEqual(simLeg.target, controlLeg.target)) reasons.push(`R${rr}_TARGET_DIVERGENCE`);

  if (simStatus === 'OPEN') {
    if (!priceEqual(simLeg.currentStop, controlLeg.currentStop)) reasons.push(`R${rr}_CURRENT_STOP_DIVERGENCE`);
    if (String(simLeg.stopStage || '') !== String(controlLeg.stopStage || '')) reasons.push(`R${rr}_STOP_STAGE_DIVERGENCE`);
    return reasons;
  }

  if (simStatus === 'TARGET_HIT' || simStatus === 'STOP_HIT' || simStatus === 'TIME_STOP_EXIT') {
    if (!rEqual(simLeg.resultR, controlLeg.resultR)) reasons.push(`R${rr}_RESULT_R_DIVERGENCE`);
    if (!priceEqual(simLeg.exitPrice, controlLeg.exitPrice)) reasons.push(`R${rr}_EXIT_PRICE_DIVERGENCE`);
    if (String(simLeg.closeReason || '') !== String(controlLeg.closeReason || '')) reasons.push(`R${rr}_CLOSE_REASON_DIVERGENCE`);
  }

  if (simLeg.exitCandleOpenAt !== controlLeg.exitCandleOpenAt) reasons.push(`R${rr}_EXIT_CANDLE_OPEN_DIVERGENCE`);
  if (simLeg.exitCandleCloseAt !== controlLeg.exitCandleCloseAt) reasons.push(`R${rr}_EXIT_CANDLE_CLOSE_DIVERGENCE`);
  return reasons;
}

function compareControlIntegrity(sim, control) {
  const reasons = [];
  if (!control) return { status:'UNKNOWN_CONTROL_STATE', reasons:['CONTROL_CANDIDATE_NOT_IN_LEDGER_FOLD'] };

  const simEntry = sim && sim.entryStatus;
  const controlEntered = ['OPEN_PAPER', 'CLOSED_PAPER'].includes(control.status);

  // The frozen shadow policy has a 0.25 ATR minimum actual-entry risk distance.
  // The certified v12.0.5.1 control has no equivalent minimum. This is a declared
  // policy-domain exclusion, not a replay-integrity failure, provided the exact
  // entry candle, entry price, and frozen planned stop all match.
  if (simEntry === 'INVALID_RISK_DISTANCE' && controlEntered && sim.invalidReason === 'RISK_DISTANCE_BELOW_025_ATR') {
    sameEntryWitness(sim, control, reasons);
    if (!reasons.length) {
      return {
        status:'PASS',
        reasons:[],
        policyDomainExclusion:{
          code:'MINIMUM_ENTRY_RISK_DISTANCE_ATR_GUARD',
          reason:'CERTIFIED_CONTROL_HAS_NO_025_ATR_MINIMUM_WHILE_FROZEN_SHADOW_POLICY_DOES',
          entryRiskDistanceATR:finite(sim.entryRiskDistanceATR),
          thresholdATR:0.25,
          economicInterpretation:'EXCLUDED_FROM_CONTROL_PARITY_FAILURE_AND_RETAINED_AS_ZERO_OPPORTUNITY_R_BY_FROZEN_ITT_POLICY',
        },
      };
    }
    return { status:'CONTROL_PARITY_DIVERGENCE', reasons:unique(reasons) };
  }

  // Both engines reject the same first eligible candle when the planned stop is
  // on the invalid side (or collapses to zero distance). Their labels differ,
  // but neither creates economic exposure.
  if (simEntry === 'INVALID_RISK_DISTANCE' && control.status === 'EXPIRED' && sim.invalidReason === 'ENTRY_STOP_SIDE_INVALID') {
    if (sim.entryCandleOpenAt !== control.expiryCandleOpenAt) reasons.push('INVALID_ENTRY_CANDLE_OPEN_DIVERGENCE');
    if (sim.entryCandleCloseAt !== control.expiryCandleCloseAt) reasons.push('INVALID_ENTRY_CANDLE_CLOSE_DIVERGENCE');
    const normalizedControl = normalizeExpiryReason(control.expiryReason);
    if (normalizedControl !== 'INVALID_ENTRY_RISK_GEOMETRY_NO_ENTRY') reasons.push('INVALID_ENTRY_REASON_DIVERGENCE');
    if (!reasons.length) {
      return {
        status:'PASS',
        reasons:[],
        policyDomainExclusion:{
          code:'ENTRY_RISK_GEOMETRY_NO_ENTRY_LABEL_NORMALIZATION',
          reason:'BOTH_CONTROL_AND_SHADOW_REJECT_THE_SAME_FIRST_ELIGIBLE_CANDLE_WITHOUT_EXPOSURE',
          economicInterpretation:'NO_ENTRY_IN_EITHER_ENGINE',
        },
      };
    }
    return { status:'CONTROL_PARITY_DIVERGENCE', reasons:unique(reasons) };
  }

  if (control.status === 'PENDING_FORWARD_ENTRY' && simEntry !== 'PENDING') reasons.push('ENTRY_STATUS_DIVERGENCE');
  if (control.status === 'EXPIRED' && simEntry !== 'EXPIRED') reasons.push('ENTRY_STATUS_DIVERGENCE');
  if (controlEntered && simEntry !== 'ENTERED') reasons.push('ENTRY_STATUS_DIVERGENCE');

  if (simEntry === 'EXPIRED' && control.status === 'EXPIRED') {
    if (sim.expiryCandleOpenAt !== control.expiryCandleOpenAt) reasons.push('EXPIRY_CANDLE_OPEN_DIVERGENCE');
    if (sim.expiryCandleCloseAt !== control.expiryCandleCloseAt) reasons.push('EXPIRY_CANDLE_CLOSE_DIVERGENCE');
    const simReason = normalizeExpiryReason(sim.expiryReason);
    const controlReason = normalizeExpiryReason(control.expiryReason);
    if (simReason && controlReason && simReason !== controlReason) reasons.push('EXPIRY_REASON_DIVERGENCE');
  }

  if (simEntry === 'ENTERED' && controlEntered) {
    sameEntryWitness(sim, control, reasons);
    for (const rr of RR_LEGS) reasons.push(...compareLeg(sim.legs && sim.legs[`R${rr}`], control.legs && control.legs[`R${rr}`], rr));
  }

  return { status:reasons.length ? 'CONTROL_PARITY_DIVERGENCE' : 'PASS', reasons:unique(reasons) };
}

class PolicyShadowEngine extends base.PolicyShadowEngine {
  constructor(options) {
    super(options);
    this.integrityNormalizedPersistenceKeys = new Set();
  }

  repairPersistenceInvariant() {
    let repaired = 0;
    const inspect = (entry, key, append) => {
      if (!entry || this.integrityNormalizedPersistenceKeys.has(key)) return;
      const expectedActive = Number(entry.writesStarted || 0) > (Number(entry.writesCommitted || 0) + Number(entry.writesFailed || 0));
      const derived = expectedActive || (append ? (Array.isArray(entry.queue) && entry.queue.length > 0) : Boolean(entry.pending)) || Boolean(entry.retryTimer);
      if (entry.writing === true && !derived) {
        entry.writing = false;
        this.integrityNormalizedPersistenceKeys.add(key);
        repaired++;
      }
    };

    for (const [file, entry] of this.persistQueue.files.entries()) inspect(entry, `state:${file}`, false);
    for (const [file, entry] of this.persistQueue.appendFiles.entries()) inspect(entry, `append:${file}`, true);

    if (repaired > 0) {
      this.state.persistenceInvariantRepairs = Number(this.state.persistenceInvariantRepairs || 0) + repaired;
      this.state.persistenceInvariantRepairsSincePatch = Number(this.state.persistenceInvariantRepairsSincePatch || 0) + repaired;
      this.state.lastInvariantRepairAt = new Date(this.now()).toISOString();
      this.state.lastInvariantRepairReason = 'ONE_TIME_STALE_WRITING_TELEMETRY_NORMALIZATION_PER_FILE';
    }
  }

  async processFrameClusters(frameClusters, source, controlStates, controlCutoffMs, witnessEvents) {
    const outcomes = await super.processFrameClusters(frameClusters, source, controlStates, controlCutoffMs, witnessEvents);
    for (const outcome of outcomes) {
      const arm = outcome && outcome.arms && outcome.arms.E0_X0;
      if (!arm) continue;
      const parity = [];
      for (const candidateId of arm.memberCandidateIds || []) {
        parity.push({ candidateId, ...compareControlIntegrity(arm, controlStates.get(candidateId)) });
      }
      arm.controlParity = parity;
      arm.controlParityPolicyDomainExclusions = parity.filter(row => row.policyDomainExclusion).map(row => ({ candidateId:row.candidateId, ...row.policyDomainExclusion }));
      arm.controlParityStatus = parity.some(row => row.status === 'CONTROL_PARITY_DIVERGENCE')
        ? 'CONTROL_PARITY_DIVERGENCE'
        : parity.some(row => row.status !== 'PASS')
          ? 'UNKNOWN_CONTROL_STATE'
          : 'PASS';
    }
    return outcomes;
  }

  diagnostics(outcomes, armScores) {
    const diagnostics = super.diagnostics(outcomes, armScores);
    const exclusions = [];
    for (const outcome of outcomes || []) {
      for (const row of outcome && outcome.arms && outcome.arms.E0_X0 && outcome.arms.E0_X0.controlParityPolicyDomainExclusions || []) {
        exclusions.push({ baseEvidenceClusterId:outcome.baseEvidenceClusterId, ...row });
      }
    }
    return {
      ...diagnostics,
      integrityPatchVersion:INTEGRITY_PATCH_VERSION,
      controlParityPolicyDomainExclusions:exclusions,
    };
  }

  view() {
    const view = super.view();
    return {
      ...view,
      integrityPatchVersion:INTEGRITY_PATCH_VERSION,
      persistenceInvariantRepairsSincePatch:Number(this.state.persistenceInvariantRepairsSincePatch || 0),
      persistenceTelemetry:{
        mode:'DERIVED_QUEUE_REALITY_WITH_ONE_TIME_NORMALIZATION_PER_FILE',
        historicalRepairCountPreserved:true,
        repeatedViewTimeRepairCountingDisabled:true,
      },
    };
  }

  diagnosticsView() {
    return {
      ...super.diagnosticsView(),
      integrityPatchVersion:INTEGRITY_PATCH_VERSION,
    };
  }
}

module.exports = {
  ...base,
  PolicyShadowEngine,
  INTEGRITY_PATCH_VERSION,
  compareControlIntegrity,
};
