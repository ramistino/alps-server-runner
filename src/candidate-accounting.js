'use strict';

const { asObject, finite, text } = require('./utils');

function buildCandidateAccounting({ live, candidateAuthority, candidateVisibilityAudit }) {
  const current = asObject(live && live.currentHealth);
  const authority = asObject(candidateAuthority);
  const visibilityAudit = asObject(candidateVisibilityAudit);

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

  const quarantineReasons = asObject(authority.quarantineReasons || current.candidateQuarantineReasons);
  const reasonCount = Object.values(quarantineReasons)
    .reduce((sum, value) => sum + Math.max(0, finite(value, 0)), 0);
  const explainedBeforeLatch = Math.max(quarantined, incomplete + analytical, reasonCount);
  const unresolvedBeforeLatch = Math.max(0, discoveryToLatchGap - explainedBeforeLatch);

  const auditRows = Math.max(0, finite(visibilityAudit.totalCandidates, 0));
  const comparableCohort = auditRows > 0 && auditRows === latch;
  const observationalDelta = Math.max(0, latch - paperSeen);
  const auditedUnresolved = comparableCohort
    ? Math.max(0, finite(visibilityAudit.unresolvedLegacyVisibilityGap, 0))
    : null;

  // paperEntryVisibilityCandidatesSeen is a scanner observation, not a mutually exclusive
  // cohort transition. It must never be subtracted from the latch as a proven loss unless
  // both sides carry the same full candidate cohort.
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
    (nativePool === candidates && incomplete === 0 && quarantined === 0);
  const gatePass = unresolvedBeforeLatch === 0 && authorityReconciled &&
    incomplete === 0 && quarantined === 0;

  return {
    schema:'alps.v10200.candidateAccounting.v2',
    status:gatePass ? 'EXECUTABLE_CANDIDATE_PIPELINE_ACCOUNTED' : 'CANDIDATE_PIPELINE_GAPS_PRESENT',
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
      discoveryToLatchExplained:explainedBeforeLatch,
      discoveryToLatchUnresolved:unresolvedBeforeLatch,
      paperVisibilityObservationDelta:observationalDelta,
      paperVisibilityComparableCohort:comparableCohort,
      paperVisibilityStatus:paperVisibilityTransition.status,
      latchToPaperVisibilityGap:paperVisibilityTransition.latchToPaperVisibilityGap,
      latchToPaperVisibilityExplained:paperVisibilityTransition.latchToPaperVisibilityExplained,
      latchToPaperVisibilityUnresolved:paperVisibilityTransition.latchToPaperVisibilityUnresolved,
    },
    reasons:{
      candidateQuarantineReasons:quarantineReasons,
      v102VisibilityAuditStatus:text(visibilityAudit.status, 'NOT_AVAILABLE'),
      paperVisibilityRule:'Scanner visibility is an observational view. It becomes an accounting transition only when a complete same-cohort candidate feed is available.',
    },
    audit:{
      status:text(visibilityAudit.status, 'NOT_AVAILABLE'),
      comparableCohort,
      auditRows,
      validExecutionContracts:Math.max(0, finite(visibilityAudit.validExecutionContracts, 0)),
      invalidContracts:Math.max(0, finite(visibilityAudit.invalidContracts, 0)),
      entryEligibleNow:Math.max(0, finite(visibilityAudit.entryEligibleNow, 0)),
    },
    fullAutonomy:{
      active:finite(current.fullAutonomyForward, 0) > 0,
      forwarded:Math.max(0, finite(current.fullAutonomyForward, 0)),
      eligible:Math.max(0, finite(current.autonomyEligibleCandidates, 0)),
      blocked:Math.max(0, finite(current.autonomyBlockedCandidates, 0)),
      status:text(current.autonomyEligibilityStatus || current.fullAutonomyStatus, 'NOT_ACTIVE_OR_NOT_PUBLISHED'),
    },
    rule:'Discovery, native pool and latch are strict accounting stages. Paper visibility is published separately as a scanner observation unless a complete same-cohort key set proves comparability.',
  };
}

module.exports = { buildCandidateAccounting };
