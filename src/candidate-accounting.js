'use strict';

const { asObject, finite, text } = require('./utils');

function buildCandidateAccounting({ live, candidateAuthority, candidateVisibilityAudit }) {
  const current = asObject(live && live.currentHealth);
  const authority = asObject(candidateAuthority);
  const candidates = Math.max(0, finite(live && live.candidates, current.candidates || 0));
  const nativePool = Math.max(0, finite(live && live.nativePoolCandidates, current.nativePoolCandidates || 0));
  const latch = Math.max(0, finite(live && live.forwardLatchSize, current.forwardLatchSize || 0));
  const paperSeen = Math.max(0, finite(live && live.paperEntryVisibilityCandidatesSeen, current.paperEntryVisibilityCandidatesSeen || 0));
  const pending = Math.max(0, finite(current.pendingEntries, current.persistentEvidencePendingEntries || 0));
  const open = Math.max(0, finite(live && live.openPositions, current.openPositions || 0));
  const rejected = Math.max(0, finite(live && live.rejected, current.rejected || 0));
  const quarantined = Math.max(0, finite(authority.quarantinedRows, current.quarantinedCandidateRows || 0));
  const incomplete = Math.max(0, finite(authority.incompleteExecutionContracts, current.incompleteExecutionContracts || 0));
  const analytical = Math.max(0, finite(authority.analyticalRegistryRows, current.analyticalRegistryRows || 0));
  const latchGap = Math.max(0, candidates - latch);
  const paperVisibilityGap = Math.max(0, latch - paperSeen);

  const reasons = asObject(authority.quarantineReasons || current.candidateQuarantineReasons);
  const reasonCount = Object.values(reasons).reduce((sum, value) => sum + Math.max(0, finite(value, 0)), 0);
  const explainedBeforeLatch = Math.max(quarantined, incomplete + analytical, reasonCount);
  const unresolvedBeforeLatch = Math.max(0, candidates - latch - explainedBeforeLatch);

  // Pending/open/rejected are overlapping lifecycle views in the legacy engine. They are not summed as exclusive buckets.
  // v10.2.0 therefore reports transition gaps rather than presenting a false accounting identity.
  const visibilityAudit = asObject(candidateVisibilityAudit);
  const visibilityExplanation = asObject(current.paperVisibilityGapReasons || current.paperEntryGapReasons || visibilityAudit.reasonCounts);
  const auditExplained = Math.max(0, finite(visibilityAudit.gapExplainedByInvalidContracts, 0));
  const publishedExplained = Object.values(visibilityExplanation).reduce((sum, value) => sum + Math.max(0, finite(value, 0)), 0);
  const visibilityExplained = Math.min(paperVisibilityGap, Math.max(auditExplained, publishedExplained));
  const unresolvedVisibilityGap = Math.max(0, paperVisibilityGap - visibilityExplained);

  const status = unresolvedBeforeLatch === 0 && unresolvedVisibilityGap === 0
    ? 'CANDIDATE_TRANSITIONS_ACCOUNTED'
    : 'CANDIDATE_TRANSITION_GAPS_PRESENT';

  return {
    schema:'alps.v10200.candidateAccounting.v1',
    status,
    stages:{
      discoveredCandidates:candidates,
      nativePool,
      forwardLatch:latch,
      paperVisibilitySeen:paperSeen,
      pendingEntries:pending,
      openPositions:open,
      rejectedObservations:rejected,
      quarantined,
      incompleteContracts:incomplete,
      analyticalOnly:analytical,
    },
    transitions:{
      discoveryToLatchGap:latchGap,
      discoveryToLatchExplained:explainedBeforeLatch,
      discoveryToLatchUnresolved:unresolvedBeforeLatch,
      latchToPaperVisibilityGap:paperVisibilityGap,
      latchToPaperVisibilityExplained:visibilityExplained,
      latchToPaperVisibilityUnresolved:unresolvedVisibilityGap,
    },
    reasons:{
      candidateQuarantineReasons:reasons,
      paperVisibilityGapReasons:visibilityExplanation,
      v102VisibilityAuditStatus:text(visibilityAudit.status, 'NOT_AVAILABLE'),
    },
    fullAutonomy:{
      active:finite(current.fullAutonomyForward, 0) > 0,
      forwarded:Math.max(0, finite(current.fullAutonomyForward, 0)),
      eligible:Math.max(0, finite(current.autonomyEligibleCandidates, 0)),
      blocked:Math.max(0, finite(current.autonomyBlockedCandidates, 0)),
      status:text(current.autonomyEligibilityStatus || current.fullAutonomyStatus, 'NOT_ACTIVE_OR_NOT_PUBLISHED'),
    },
    v102VisibilityAudit:visibilityAudit && visibilityAudit.schema ? { totalCandidates:visibilityAudit.totalCandidates, validExecutionContracts:visibilityAudit.validExecutionContracts, invalidContracts:visibilityAudit.invalidContracts, entryEligibleNow:visibilityAudit.entryEligibleNow, unresolvedLegacyVisibilityGap:visibilityAudit.unresolvedLegacyVisibilityGap } : null,
    rule:'Counts are published as stage transitions. Overlapping lifecycle views (pending/open/rejected) are never added together as if they were exclusive buckets.',
  };
}

module.exports = { buildCandidateAccounting };
