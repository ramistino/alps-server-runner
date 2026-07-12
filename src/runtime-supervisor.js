'use strict';

const { ageSec, iso, summarizeError, timestamp } = require('./utils');

class RuntimeSupervisor {
  constructor({ config, adapter, orchestrator, log = console.log }) {
    this.config = config;
    this.adapter = adapter;
    this.orchestrator = orchestrator;
    this.log = log;
    this.timer = null;
    this.inFlight = false;
    this.sequence = 0;
    this.lastStartedAt = null;
    this.lastCompletedAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.lastDecision = 'NOT_STARTED';
    this.lastDecisionAt = null;
    this.consecutiveProbeFailures = 0;
    this.consecutiveFastStalls = 0;
    this.consecutiveOperationalFailures = 0;
    this.restartCount = 0;
    this.lastRestartAt = null;
    this.lastRestartReason = null;
    this.actions = [];
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(
      () => this.tick('interval').catch(error => this.log('[runtime-supervisor] tick failed', summarizeError(error))),
      this.config.supervisorPollMs
    );
    this.timer.unref();
    setTimeout(() => this.tick('startup').catch(()=>{}), 5_000).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  record(action, detail = {}) {
    const row = { at:iso(), action, ...detail };
    this.actions.push(row);
    if (this.actions.length > 40) this.actions.splice(0, this.actions.length - 40);
    this.lastDecision = action;
    this.lastDecisionAt = row.at;
    return row;
  }

  status() {
    return {
      schema:'alps.v10201.runtimeSupervisor.v1',
      status:this.lastError ? 'DEGRADED' : (this.lastSuccessAt ? 'SUPERVISOR_ACTIVE' : 'STARTING'),
      sequence:this.sequence,
      inFlight:this.inFlight,
      lastStartedAt:this.lastStartedAt,
      lastCompletedAt:this.lastCompletedAt,
      lastSuccessAt:this.lastSuccessAt,
      lastError:this.lastError,
      lastDecision:this.lastDecision,
      lastDecisionAt:this.lastDecisionAt,
      consecutiveProbeFailures:this.consecutiveProbeFailures,
      consecutiveFastStalls:this.consecutiveFastStalls,
      consecutiveOperationalFailures:this.consecutiveOperationalFailures,
      restartCount:this.restartCount,
      lastRestartAt:this.lastRestartAt,
      lastRestartReason:this.lastRestartReason,
      actions:this.actions.slice(-20),
      rule:'The supervisor never waits for heavy evidence. It directly probes the private adapter, expires orphaned fast attempts, opens the heavy circuit on degradation, and performs a controlled child restart only after repeated independent failures.',
    };
  }

  async tick(reason = 'manual') {
    if (this.inFlight) return this.status();
    this.inFlight = true;
    this.sequence += 1;
    this.lastStartedAt = iso();
    const started = Date.now();
    try {
      const runtime = this.orchestrator.runtimeView();
      const fast = runtime.fast || {};
      const fastAge = ageSec(fast.lastSuccessAt, Date.now());
      const fastAttemptAge = fast.inFlight && fast.lastStartedAt
        ? ageSec(fast.lastStartedAt, Date.now())
        : 0;
      const heavy = runtime.heavy || {};
      const heavyAttemptAge = heavy.inFlight && heavy.lastStartedAt
        ? ageSec(heavy.lastStartedAt, Date.now())
        : 0;

      if (fast.inFlight && fastAttemptAge * 1000 > this.config.fastHardDeadlineMs) {
        this.orchestrator.expireFastAttempt('SUPERVISOR_FAST_ATTEMPT_HARD_DEADLINE');
        this.record('EXPIRE_ORPHANED_FAST_ATTEMPT', { fastAttemptAgeSec:Math.round(fastAttemptAge * 1000) / 1000 });
      }
      if (heavy.inFlight && heavyAttemptAge * 1000 > this.config.heavyHardDeadlineMs) {
        this.orchestrator.openHeavyCircuit('SUPERVISOR_HEAVY_HARD_DEADLINE');
        this.record('OPEN_HEAVY_CIRCUIT', { heavyAttemptAgeSec:Math.round(heavyAttemptAge * 1000) / 1000 });
      }

      const probe = await this.adapter.probe(this.config.supervisorProbeTimeoutMs);
      if (probe.ok) {
        this.consecutiveProbeFailures = 0;
      } else {
        this.consecutiveProbeFailures += 1;
      }

      const staleFast = !Number.isFinite(fastAge) || fastAge >= this.config.fastStallSec;
      const fastRecoveryEligible = Boolean(fast.lastSuccessAt)
        ? staleFast
        : (!fast.inFlight || fastAttemptAge * 1000 >= this.config.fastHardDeadlineMs / 2);
      if (staleFast) {
        this.consecutiveFastStalls += 1;
        this.orchestrator.openHeavyCircuit('FAST_HEALTH_DEGRADED_HEAVY_PROTECTION');
      } else {
        this.consecutiveFastStalls = 0;
      }

      const inspected = this.orchestrator.snapshot('runtime-supervisor-inspection');
      const runtimeAgeSec = ageSec(runtime.startedAt, Date.now());
      const operationalGracePassed = Number.isFinite(runtimeAgeSec) && runtimeAgeSec >= this.config.supervisorOperationalGraceSec;
      const operationalDegraded = Boolean(
        fast.lastSuccessAt &&
        operationalGracePassed &&
        inspected.layers &&
        inspected.layers.featureEngine && inspected.layers.featureEngine.fresh &&
        (
          !inspected.layers.strategyEngine || !inspected.layers.strategyEngine.fresh ||
          !inspected.layers.researchCycle || !inspected.layers.researchCycle.fresh ||
          !inspected.layers.sentinel || !inspected.layers.sentinel.fresh
        )
      );
      if (operationalDegraded) {
        this.consecutiveOperationalFailures += 1;
        this.orchestrator.openHeavyCircuit('OPERATIONAL_HEARTBEAT_DEGRADED_HEAVY_PROTECTION');
        if (this.consecutiveOperationalFailures < this.config.operationalFailureRestartThreshold) {
          await this.orchestrator.recoveryTick('supervisor-operational-heartbeat-recovery');
          this.record('OPERATIONAL_RECOVERY_REQUESTED', {
            consecutiveOperationalFailures:this.consecutiveOperationalFailures,
            strategyStatus:inspected.layers.strategyEngine && inspected.layers.strategyEngine.status,
            researchStatus:inspected.layers.researchCycle && inspected.layers.researchCycle.status,
            sentinelStatus:inspected.layers.sentinel && inspected.layers.sentinel.status,
          });
        }
      } else {
        this.consecutiveOperationalFailures = 0;
      }

      if (fastRecoveryEligible && probe.ok) {
        this.orchestrator.expireFastAttempt('SUPERVISOR_FAST_STALE_WITH_READY_ADAPTER');
        const recovered = await this.orchestrator.fastPoll('supervisor-direct-fast-recovery');
        const nowAge = ageSec(this.orchestrator.runtimeView().fast.lastSuccessAt, Date.now());
        if (Number.isFinite(nowAge) && nowAge < this.config.fastStallSec) {
          this.consecutiveFastStalls = 0;
          this.consecutiveProbeFailures = 0;
          this.record('RECOVER_FAST_WORKER_WITHOUT_ADAPTER_RESTART', { reason, priorFastAgeSec:Math.round(fastAge * 1000) / 1000 });
          this.lastError = null;
          this.lastSuccessAt = iso();
          return recovered;
        }
      }

      const restartCooldownAge = this.lastRestartAt
        ? ageSec(this.lastRestartAt, Date.now())
        : Infinity;
      const restartAllowed = restartCooldownAge >= this.config.adapterRestartCooldownSec;
      const restartRequired = (
        !this.adapter.status().running ||
        this.consecutiveProbeFailures >= this.config.fastFailureRestartThreshold ||
        (fastRecoveryEligible && this.consecutiveFastStalls >= this.config.fastFailureRestartThreshold) ||
        this.consecutiveOperationalFailures >= this.config.operationalFailureRestartThreshold
      );

      if (restartRequired && restartAllowed) {
        const restartReason = !this.adapter.status().running
          ? 'ADAPTER_PROCESS_NOT_RUNNING'
          : this.consecutiveOperationalFailures >= this.config.operationalFailureRestartThreshold
            ? `OPERATIONAL_HEARTBEAT_STALL_${this.consecutiveOperationalFailures}`
            : `FAST_HEALTH_STALL_PROBE_FAILURES_${this.consecutiveProbeFailures}`;
        this.orchestrator.openHeavyCircuit(`ADAPTER_RESTART:${restartReason}`);
        await this.adapter.restart(restartReason);
        this.restartCount += 1;
        this.lastRestartAt = iso();
        this.lastRestartReason = restartReason;
        this.consecutiveProbeFailures = 0;
        this.consecutiveFastStalls = 0;
        this.consecutiveOperationalFailures = 0;
        await this.orchestrator.afterAdapterRestart(restartReason);
        this.record('CONTROLLED_ADAPTER_RESTART_COMPLETED', { restartReason, reason });
        this.lastError = null;
        this.lastSuccessAt = iso();
        return this.status();
      } else if (restartRequired && !restartAllowed) {
        this.record('ADAPTER_RESTART_COOLDOWN_ACTIVE', { restartCooldownAgeSec:Math.round(restartCooldownAge * 1000) / 1000 });
      } else if (!staleFast && probe.ok && !operationalDegraded) {
        this.record('HEALTHY_NO_ACTION', { reason, fastAgeSec:Math.round(fastAge * 1000) / 1000 });
      }

      if (probe.ok && !staleFast && !operationalDegraded) {
        this.lastError = null;
        this.lastSuccessAt = iso();
      } else if (!this.lastError) {
        this.lastError = {
          name:'SupervisorDegradedEvidence',
          message:operationalDegraded ? 'Operational heartbeat is degraded' : (staleFast ? 'Fast health is stale' : 'Adapter probe failed'),
          code:operationalDegraded ? 'OPERATIONAL_HEARTBEAT_DEGRADED' : (staleFast ? 'FAST_HEALTH_STALE' : 'ADAPTER_PROBE_FAILED'),
        };
        if (!restartRequired) this.record('FAILURE_CONFIRMATION_PENDING', {
          consecutiveProbeFailures:this.consecutiveProbeFailures,
          consecutiveFastStalls:this.consecutiveFastStalls,
          consecutiveOperationalFailures:this.consecutiveOperationalFailures,
        });
      }
      return this.status();
    } catch (error) {
      this.lastError = summarizeError(error);
      this.record('SUPERVISOR_ERROR', { error:this.lastError });
      throw error;
    } finally {
      this.inFlight = false;
      this.lastCompletedAt = iso();
      this.durationMs = Date.now() - started;
    }
  }
}

module.exports = { RuntimeSupervisor };
