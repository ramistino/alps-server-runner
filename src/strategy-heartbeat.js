'use strict';

const { asObject, bool, finite, iso, text } = require('./utils');

class StrategyHeartbeat {
  constructor() {
    this.sequence = 0;
    this.lastObservedAt = null;
    this.lastHealthyAt = null;
    this.lastResearchCycleAt = null;
    this.lastSourceGeneratedAt = null;
    this.lastSourceVersion = null;
    this.lastCurrentHealthAgeSec = null;
    this.lastLabRunning = false;
    this.lastResearchReady = false;
    this.lastCandidateFlowReady = false;
    this.consecutiveHealthy = 0;
    this.consecutiveUnhealthy = 0;
    this.lastReason = 'NOT_OBSERVED_YET';
  }

  observe(live, now = Date.now()) {
    const root = asObject(live);
    const current = asObject(root.currentHealth);
    const freshness = asObject(root.currentHealthFreshness || current.currentHealthFreshness);

    const sourceFresh = bool(root.currentHealthFresh) || bool(current.currentHealthFresh) || bool(freshness.fresh);
    const labRunning = bool(root.labRunning) || bool(current.labRunning);
    const researchReady = bool(root.researchReady) || bool(current.researchReady) || labRunning;
    const nativePool = Math.max(0, finite(root.nativePoolCandidates, current.nativePoolCandidates || 0));
    const latch = Math.max(0, finite(root.forwardLatchSize, current.forwardLatchSize || 0));
    const candidateFlowReady = nativePool > 0 && latch > 0;
    const healthy = sourceFresh && labRunning && researchReady;
    const researchHealthy = healthy && candidateFlowReady;

    this.sequence += 1;
    this.lastObservedAt = iso(now);
    this.lastSourceGeneratedAt = root.generatedAt || current.generatedAt || null;
    this.lastSourceVersion = text(root.version || current.version);
    this.lastCurrentHealthAgeSec = finite(root.currentHealthAgeSec, freshness.ageSec || null);
    this.lastLabRunning = labRunning;
    this.lastResearchReady = researchReady;
    this.lastCandidateFlowReady = candidateFlowReady;

    if (healthy) {
      this.lastHealthyAt = iso(now);
      this.consecutiveHealthy += 1;
      this.consecutiveUnhealthy = 0;
      this.lastReason = researchHealthy ? 'LIVE_RESEARCH_AND_CANDIDATE_FLOW_CONFIRMED' : 'LIVE_STRATEGY_ENGINE_CONFIRMED';
    } else {
      this.consecutiveUnhealthy += 1;
      this.consecutiveHealthy = 0;
      if (!sourceFresh) this.lastReason = 'SOURCE_CURRENT_HEALTH_NOT_FRESH';
      else if (!labRunning) this.lastReason = 'LAB_NOT_RUNNING';
      else if (!researchReady) this.lastReason = 'RESEARCH_NOT_READY';
      else this.lastReason = 'STRATEGY_HEARTBEAT_NOT_CONFIRMED';
    }

    if (researchHealthy) this.lastResearchCycleAt = iso(now);
    return this.view();
  }

  view() {
    return {
      schema:'alps.v10200.strategyHeartbeat.v1',
      sequence:this.sequence,
      lastObservedAt:this.lastObservedAt,
      lastHealthyAt:this.lastHealthyAt,
      lastResearchCycleAt:this.lastResearchCycleAt,
      sourceGeneratedAt:this.lastSourceGeneratedAt,
      sourceVersion:this.lastSourceVersion,
      sourceCurrentHealthAgeSec:this.lastCurrentHealthAgeSec,
      labRunning:this.lastLabRunning,
      researchReady:this.lastResearchReady,
      candidateFlowReady:this.lastCandidateFlowReady,
      consecutiveHealthy:this.consecutiveHealthy,
      consecutiveUnhealthy:this.consecutiveUnhealthy,
      lastReason:this.lastReason,
      authority:'FAST_LIVE_RESEARCH_HEARTBEAT_INDEPENDENT_OF_HEAVY_CANDIDATE_AUTHORITY',
      rule:'A successful fast live observation with fresh currentHealth, labRunning and researchReady is the strategy heartbeat. Heavy evidence timestamps cannot make the strategy layer stale.'
    };
  }
}

module.exports = { StrategyHeartbeat };
