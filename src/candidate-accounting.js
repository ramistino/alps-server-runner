'use strict';

const { asObject, finite, text } = require('./utils');

function buildCandidateAccounting({ live, candidateAuthority, candidateVisibilityAudit, candidateCohort }) {
  const current = asObject(live && live.currentHealth);
  const authority = asObject(candidateAuthority);
  const visibilityAudit = asObject(candidateVisibilityAudit);
  const cohort = asObject(candidateCohort);

  const candidates = Math.max(0, finite(live && live.candidates, current.candidates || 0));
  const nativePool = Math.max(0, finite(live && live.nativePoolCandidates, current.nativePoolCandidates || 0));
  const latch = Math.max(0, finite(live && live.forwardLatchSize, current.forwardLatchSize || 0));
  const paperSeen = Math.max(0, finite(
    live && live.paperEntryVisibilityCandidatesSeen,
    current.paperEntryVisibilityCandidatesSeen || 0
  ));
  const pending = Math.max(0, finite(current.pendingEntries, current.persistentEvidencePendingEntries || 0));
  const open = Math.max(0, finite(live && live.openPositions, current.openPositions || 0));
  const rejected = Math.max(0, finite(live && live.rejected, current.rejected || 0));
  const quarantined = Math.max(0, finite(authority.quarantinedRows, current.quarantinedCandidateRows || 0));
  const incomplete = Math.max(0, finite(authority.incompleteExecutionContracts, current.incompleteExecutionContracts || 0));
  const analytical = Math.max(0, finite(authority.analyticalRegistryRows, current.analyticalRegistryRows || 0));

  const discoveryToNativeGap = Math.max(0, candidates - nativePool);
  const nativeToLatchGap = Math.max(0, nativePool - latch);
  const discoveryToLatchGap = Math.max(0, candidates - latch);
  const nativeOverflow = Math.max(0, nativePool - candidates);
  const latchOverflow = Math.max(0, latch - nativePool);

  const quarantineReasons = asObject(authority.quarantineReasons || current.candidateQuarantineReasons);
  const reasonCount = Object.values(quarantineReasons)
    .reduce((sum, value) => sum + Math.max(0, finite(value, 0)), 0);
  const explainedBeforeLatch = Math.max(quarantined, incomplete + analytical, reasonCount);

  const cohortPersistent = Boolean(cohort.persistentGapConfirmed);
  const cohortPass = cohort.pass !== false;
  const strictMismatch = Math.max(discoveryToLatchGap, nativeOverflow, latchOverflow);
  const transientGap = strictMismatch > 0 && !cohortPersistent;
  const persistentUnresolved = cohortPersistent
    ? Math.max(0, strictMismatch - explainedBeforeLatch)
    : 0;

  const auditRows = Math.max(0, finite(visibilityAudit.totalCandidates, 0));
  const comparableCohort = auditRows > 0 && auditRows === latch;
  const observationalDelta = Math.max(0, latch - paperSeen);
  const auditedUnresolved = comparableCohort
    ? Math.max(0, finite(visibilityAudit.unresolvedLegacyVisibilityGap, 0))
    : null;

  const paperVisibilityTransition = comparableCohort
    ? {
        comparable:true,
        status:auditedUnresolved === 0 ? 'AUDITED_COHORT_ACCOUNTED' : 'AUDITED_COHORT_GAP_PRESENT',
        latchToPaperVisibilityGap:observationalDelta,
        latchToPaperVisibilityExplained:Math.max(0, observationalDelta - auditedUnresolved),
        latchToPaperVisibilityUnresolved:auditedUnresolved,
      }
    : {
        comparable:false,
        status:'NOT_COMPARABLE_DIFFERENT_VIEW_SEMANTICS',
        latchToPaperVisibilityGap:observationalDelta,
        latchToPaperVisibilityExplained:null,
        latchToPaperVisibilityUnresolved:null,
      };

  const authorityReconciled = text(authority.status).includes('RECONCILED') ||
    (nativePool <= candidates && incomplete === 0 && quarantined === 0);
  const gatePass = cohortPass && persistentUnresolved === 0 && authorityReconciled &&
    incomplete === 0 && quarantined === 0;

  return {
    schema:'alps.v10200.candidateAccounting.v3',
    status:gatePass
      ? (transientGap ? 'TRANSITION_IN_FLIGHT_ACCOUNTED_BY_COHORT_GRACE' : 'EXECUTABLE_CANDIDATE_PIPELINE_ACCOUNTED')
      : 'PERSISTENT_CANDIDATE_PIPELINE_GAP_CONFIRMED',
    pass:gatePass,
    stages:{
      discoveredCandidates:candidates,
      nativePool,
      forwardLatch:latch,
      paperVisibilityObserved:paperSeen,
      pendingEntries:pending,
      openPositions:open,
      rejectedObservations:rejected,
      quarantined,
      incompleteContracts:incomplete,
      analyticalOnly:analytical,
    },
    transitions:{
      discoveryToNativeGap,
      nativeToLatchGap,
      discoveryToLatchGap,
      nativeOverflow,
      latchOverflow,
      discoveryToLatchExplained:explainedBeforeLatch,
      discoveryToLatchTransient:transientGap ? discoveryToLatchGap : 0,
      discoveryToLatchPersistentConfirmed:cohortPersistent,
      discoveryToLatchUnresolved:persistentUnresolved,
      paperVisibilityObservationDelta:observationalDelta,
      paperVisibilityComparableCohort:comparableCohort,
      paperVisibilityStatus:paperVisibilityTransition.status,
      latchToPaperVisibilityGap:paperVisibilityTransition.latchToPaperVisibilityGap,
      latchToPaperVisibilityExplained:paperVisibilityTransition.latchToPaperVisibilityExplained,
      latchToPaperVisibilityUnresolved:paperVisibilityTransition.latchToPaperVisibilityUnresolved,
    },
    cohort,
    reasons:{
      candidateQuarantineReasons:quarantineReasons,
      v102VisibilityAuditStatus:text(visibilityAudit.status, 'NOT_AVAILABLE'),
      paperVisibilityRule:'Scanner visibility is observational and never blocks accounting unless a complete same-cohort candidate feed proves comparability.',
      candidateGapRule:'A discovery/native/latch mismatch blocks only after the identical cohort tuple persists long enough to be confirmed by the cohort authority.',
    },
    audit:{
      status:text(visibilityAudit.status, 'NOT_AVAILABLE'),
      comparableCohort,
      auditRows,
      validExecutionContracts:Math.max(0, finite(visibilityAudit.validExecutionContracts, 0)),
      invalidContracts:Math.max(0, finite(visibilityAudit.invalidContracts, 0)),
      entryEligibleNow:Math.max(0, finite(visibilityAudit.entryEligibleNow, 0)),
    },
    legacyAutonomy:{
      active:finite(current.fullAutonomyForward, 0) > 0,
      forwarded:Math.max(0, finite(current.fullAutonomyForward, 0)),
      eligible:Math.max(0, finite(current.autonomyEligibleCandidates, 0)),
      blocked:Math.max(0, finite(current.autonomyBlockedCandidates, 0)),
      status:text(current.autonomyEligibilityStatus || current.fullAutonomyStatus, 'NOT_ACTIVE_OR_NOT_PUBLISHED'),
    },
    fullAutonomy:null,
    rule:'Discovery, native pool and latch are strict stages governed by persistent cohort confirmation. Paper visibility remains a separate scanner observation.'
  };
}

module.exports = { buildCandidateAccounting };
