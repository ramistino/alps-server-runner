'use strict';

const { ageSec, iso, summarizeError } = require('./utils');

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
    this.consecutiveHeartbeatStalls = 0;
    this.consecutiveOperationalFailures = 0;
    this.restartCount = 0;
    this.lastRestartAt = null;
    this.lastRestartReason = null;
    this.actions = [];
    this.durationMs = 0;
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
      schema:'alps.v10202.runtimeSupervisor.v1',
      version:this.config.version,
      status:this.lastError ? 'DEGRADED' : (this.lastSuccessAt ? 'SUPERVISOR_ACTIVE' : 'STARTING'),
      sequence:this.sequence,
      inFlight:this.inFlight,
      lastStartedAt:this.lastStartedAt,
      lastCompletedAt:this.lastCompletedAt,
      lastSuccessAt:this.lastSuccessAt,
      lastError:this.lastError,
      lastDecision:this.lastDecision,
      lastDecisionAt:this.lastDecisionAt,
      durationMs:this.durationMs,
      consecutiveProbeFailures:this.consecutiveProbeFailures,
      consecutiveHeartbeatStalls:this.consecutiveHeartbeatStalls,
      consecutiveOperationalFailures:this.consecutiveOperationalFailures,
      restartCount:this.restartCount,
      lastRestartAt:this.lastRestartAt,
      lastRestartReason:this.lastRestartReason,
      actions:this.actions.slice(-20),
      restartAuthority:'PROCESS_EXIT_OR_REPEATED_DIRECT_VERSION_PROBE_FAILURES_ONLY',
      operationalDegradationCanRestart:false,
      rule:'A healthy direct /runner/version probe blocks restart. Slow operational truth, research, sentinel, features, candidates, reports, and charts may trigger recovery actions but never kill a healthy adapter process.',
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
      const operational = runtime.operational || {};
      const fastAge = ageSec(fast.lastSuccessAt, Date.now());
      const fastAttemptAge = fast.inFlight && fast.lastStartedAt
        ? ageSec(fast.lastStartedAt, Date.now())
        : 0;
      const heavy = runtime.heavy || {};
      const heavyAttemptAge = heavy.inFlight && heavy.lastStartedAt
        ? ageSec(heavy.lastStartedAt, Date.now())
        : 0;

      if (fast.inFlight && fastAttemptAge * 1000 > this.config.fastHardDeadlineMs) {
        this.orchestrator.expireFastAttempt('SUPERVISOR_HEARTBEAT_ATTEMPT_HARD_DEADLINE');
        this.record('EXPIRE_ORPHANED_HEARTBEAT_ATTEMPT', {
          heartbeatAttemptAgeSec:Math.round(fastAttemptAge * 1000) / 1000,
        });
      }
      if (heavy.inFlight && heavyAttemptAge * 1000 > this.config.heavyHardDeadlineMs) {
        this.orchestrator.openHeavyCircuit('SUPERVISOR_HEAVY_HARD_DEADLINE');
        this.record('OPEN_HEAVY_CIRCUIT', {
          heavyAttemptAgeSec:Math.round(heavyAttemptAge * 1000) / 1000,
        });
      }

      const adapterRunningBeforeProbe = Boolean(this.adapter.status().running);
      const staleHeartbeat = !Number.isFinite(fastAge) || fastAge >= this.config.fastStallSec;
      const recentDirectHeartbeat = Boolean(adapterRunningBeforeProbe && !staleHeartbeat);

      let probe;
      if (recentDirectHeartbeat) {
        /*
         * fast.lastSuccessAt is direct evidence from the same private
         * /runner/version endpoint. Reuse it instead of issuing a duplicate
         * concurrent probe that can collide with /runner/live or recovery.
         */
        probe = {
          ok:true,
          status:200,
          source:'RECENT_FAST_DIRECT_VERSION_HEARTBEAT',
          reused:true,
        };
        this.consecutiveProbeFailures = 0;
        this.adapter.consecutiveProbeFailures = 0;
        this.adapter.lastProbeStatus = 'READY_REUSED_FAST_HEARTBEAT';
        this.adapter.lastReadyAt = fast.lastSuccessAt;
      } else {
        /*
         * Only perform an isolated confirmation probe when the normal
         * heartbeat is genuinely stale or has never succeeded.
         */
        probe = await this.adapter.probe(this.config.supervisorProbeTimeoutMs);
        if (probe.ok) this.consecutiveProbeFailures = 0;
        else this.consecutiveProbeFailures += 1;
      }

      if (staleHeartbeat) this.consecutiveHeartbeatStalls += 1;
      else this.consecutiveHeartbeatStalls = 0;

      if (staleHeartbeat && probe.ok) {
        this.orchestrator.expireFastAttempt('SUPERVISOR_HEARTBEAT_STALE_WITH_READY_ADAPTER');
        await this.orchestrator.fastPoll('supervisor-direct-heartbeat-recovery');
        const recoveredAge = ageSec(this.orchestrator.runtimeView().fast.lastSuccessAt, Date.now());
        if (Number.isFinite(recoveredAge) && recoveredAge < this.config.fastStallSec) {
          this.consecutiveHeartbeatStalls = 0;
          this.lastError = null;
          this.lastSuccessAt = iso();
          this.record('RECOVER_HEARTBEAT_WITHOUT_ADAPTER_RESTART', {
            reason,
            priorHeartbeatAgeSec:Math.round(fastAge * 1000) / 1000,
          });
        }
      }

      const inspected = this.orchestrator.snapshot('runtime-supervisor-inspection');
      const operationalAge = ageSec(operational.lastSuccessAt, Date.now());
      const operationalDegraded = Boolean(
        !Number.isFinite(operationalAge) ||
        operationalAge >= this.config.operationalFreshMaxSec ||
        operational.consecutiveFailures > 0 ||
        (inspected.layers && (
          !inspected.layers.strategyEngine || !inspected.layers.strategyEngine.fresh ||
          !inspected.layers.researchCycle || !inspected.layers.researchCycle.fresh ||
          !inspected.layers.sentinel || !inspected.layers.sentinel.fresh
        ))
      );

      if (operationalDegraded) {
        this.consecutiveOperationalFailures += 1;
        this.orchestrator.openHeavyCircuit('OPERATIONAL_TRUTH_DEGRADED_HEAVY_PROTECTION');
        if (this.consecutiveOperationalFailures === 1 ||
            this.consecutiveOperationalFailures % this.config.operationalFailureRestartThreshold === 0) {
          await this.orchestrator.recoveryTick('supervisor-operational-recovery');
          this.record('OPERATIONAL_RECOVERY_REQUESTED_NO_RESTART', {
            consecutiveOperationalFailures:this.consecutiveOperationalFailures,
            operationalAgeSec:Number.isFinite(operationalAge)
              ? Math.round(operationalAge * 1000) / 1000
              : null,
          });
        }
      } else {
        this.consecutiveOperationalFailures = 0;
      }

      const restartCooldownAge = this.lastRestartAt
        ? ageSec(this.lastRestartAt, Date.now())
        : Infinity;
      const restartAllowed = restartCooldownAge >= this.config.adapterRestartCooldownSec;
      const repeatedIsolatedProbeFailures = Boolean(
        staleHeartbeat &&
        !probe.ok &&
        this.consecutiveProbeFailures >= this.config.fastFailureRestartThreshold
      );
      const restartRequired = Boolean(
        !adapterRunningBeforeProbe ||
        !this.adapter.status().running ||
        repeatedIsolatedProbeFailures
      );

      if (restartRequired && restartAllowed) {
        const restartReason = !this.adapter.status().running
          ? 'ADAPTER_PROCESS_NOT_RUNNING'
          : `DIRECT_VERSION_PROBE_FAILURES_${this.consecutiveProbeFailures}`;
        this.orchestrator.openHeavyCircuit(`ADAPTER_RESTART:${restartReason}`);
        await this.adapter.restart(restartReason);
        this.restartCount += 1;
        this.lastRestartAt = iso();
        this.lastRestartReason = restartReason;
        this.consecutiveProbeFailures = 0;
        this.consecutiveHeartbeatStalls = 0;
        await this.orchestrator.afterAdapterRestart(restartReason);
        this.record('CONTROLLED_ADAPTER_RESTART_COMPLETED', { restartReason, reason });
        this.lastError = null;
        this.lastSuccessAt = iso();
        return this.status();
      }

      if (restartRequired && !restartAllowed) {
        this.record('ADAPTER_RESTART_COOLDOWN_ACTIVE', {
          restartCooldownAgeSec:Math.round(restartCooldownAge * 1000) / 1000,
        });
      } else if (probe.ok) {
        this.record(
          operationalDegraded ? 'PROCESS_HEALTHY_OPERATIONAL_RECOVERY_IN_PROGRESS' : 'HEALTHY_NO_ACTION',
          {
            reason,
            heartbeatAgeSec:Number.isFinite(fastAge) ? Math.round(fastAge * 1000) / 1000 : null,
            operationalDegraded,
          }
        );
      }

      if (probe.ok) {
        this.lastError = null;
        this.lastSuccessAt = iso();
      } else {
        this.lastError = {
          name:'DirectVersionProbeFailure',
          message:'Private adapter /runner/version probe failed',
          code:'DIRECT_VERSION_PROBE_FAILED',
        };
        if (!restartRequired) {
          this.record('DIRECT_PROBE_FAILURE_CONFIRMATION_PENDING', {
            consecutiveProbeFailures:this.consecutiveProbeFailures,
            required:this.config.fastFailureRestartThreshold,
          });
        }
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
