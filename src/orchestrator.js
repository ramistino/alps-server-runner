'use strict';

const { deriveFreshness } = require('./freshness');
const { buildCandidateAccounting } = require('./candidate-accounting');
const { buildFamilyAdjustedStats } = require('./family-stats');
const { auditCandidateVisibility } = require('./candidate-visibility-auditor');
const { StrategyHeartbeat } = require('./strategy-heartbeat');
const { CandidateCohortTracker } = require('./candidate-cohort-tracker');
const {
  asArray, asObject, bool, finite, iso, round, summarizeError, text, timestamp,
} = require('./utils');

class UnifiedOrchestrator {
  constructor({ config, adapter, featureEngine = null, log = console.log }) {
    this.config = config;
    this.adapter = adapter;
    this.client = adapter.client;
    this.featureEngine = featureEngine;
    this.log = log;
    this.strategyHeartbeat = new StrategyHeartbeat();
    this.candidateCohortTracker = new CandidateCohortTracker({ config, log });
    this.supervisor = null;
    this.fastAttemptId = 0;
    this.heavyAttemptId = 0;
    this.heavyCircuitOpenUntil = 0;
    this.heavyCircuitReason = null;

    this.fastTimer = null;
    this.heavyTimer = null;
    this.recoveryTimer = null;
    this.fastPolling = false;
    this.heavyPolling = false;
    this.recoveryRunning = false;

    this.raw = {
      version:null,
      live:null,
      trades:null,
      candidateAuthority:null,
      candleDepth:null,
      chartTruth:null,
      nativePool:null,
    };

    this.runtime = {
      startedAt:iso(),
      fast:{
        sequence:0,
        inFlight:false,
        lastStartedAt:null,
        lastCompletedAt:null,
        lastSuccessAt:null,
        lastError:null,
        durationMs:0,
        consecutiveFailures:0,
        expiredAttempts:0,
      },
      heavy:{
        sequence:0,
        inFlight:false,
        lastStartedAt:null,
        lastCompletedAt:null,
        lastSuccessAt:null,
        lastError:null,
        durationMs:0,
        circuitOpenUntil:null,
        circuitReason:null,
        cancelledAttempts:0,
        mode:'LIGHTWEIGHT_CONTROL_PLANE_AUTHORITY',
      },
      recovery:{
        sequence:0,
        inFlight:false,
        lastStartedAt:null,
        lastCompletedAt:null,
        lastSuccessAt:null,
        lastError:null,
        durationMs:0,
      },
      sources:{},
    };

    this.recovery = {
      schema:'alps.v10200.researchRecovery.v2',
      status:'IDLE',
      lastActionAt:null,
      lastAction:null,
      actionCount:0,
      reloadCount:0,
      actions:[],
      rule:'Recovery runs independently. Server Feature Engine readiness disables legacy feature recovery; only stale strategy/sentinel evidence can trigger browser recovery.',
    };

    this.state = this.emptyState();
  }

  emptyState() {
    return {
      schema:'alps.v10200.unifiedState.v3',
      version:this.config.version,
      generatedAt:iso(),
      status:'BOOTING',
      labRunning:false,
      researchReady:false,
      paperLifecycleRunning:false,
      layers:{},
      gates:{},
      candidateAccounting:null,
      familyAdjustedStats:null,
      metrics:{},
      recovery:{...this.recovery},
      runtime:this.runtimeView(),
      adapter:this.adapter.status(),
      lastError:null,
    };
  }

  runtimeView() {
    const sourceView = {};
    for (const [name, row] of Object.entries(this.runtime.sources)) sourceView[name] = {...row};
    return {
      startedAt:this.runtime.startedAt,
      fast:{...this.runtime.fast},
      heavy:{...this.runtime.heavy},
      recovery:{...this.runtime.recovery},
      supervisor:this.supervisor ? this.supervisor.status() : null,
      sources:sourceView,
      activeInternalRequests:this.client && this.client.activeView ? this.client.activeView() : [],
      architecture:'SUPERVISED_FAST_HEALTH_PLUS_NON_BLOCKING_AUTHORITY_REFRESH_PLUS_INDEPENDENT_RECOVERY',
    };
  }

  attachSupervisor(supervisor) {
    this.supervisor = supervisor;
    return this.runtimeView();
  }

  start() {
    if (this.fastTimer || this.heavyTimer || this.recoveryTimer) return;
    this.fastTimer = setInterval(
      () => this.fastPoll('interval').catch(error => this.log('[v10.2.1] fast poll error', summarizeError(error))),
      this.config.fastPollMs
    );
    this.heavyTimer = setInterval(
      () => this.heavyPoll('interval').catch(error => this.log('[v10.2.1] heavy poll error', summarizeError(error))),
      this.config.heavyPollMs
    );
    this.recoveryTimer = setInterval(
      () => this.recoveryTick('interval').catch(error => this.log('[v10.2.1] recovery error', summarizeError(error))),
      this.config.recoveryPollMs
    );
    this.fastTimer.unref();
    this.heavyTimer.unref();
    this.recoveryTimer.unref();

    setImmediate(() => this.fastPoll('startup').catch(()=>{}));
    setTimeout(() => this.heavyPoll('startup-after-fast-health').catch(()=>{}), 12_000).unref();
    setTimeout(() => this.recoveryTick('startup').catch(()=>{}), 8_000).unref();
  }

  stop() {
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.heavyTimer) clearInterval(this.heavyTimer);
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.fastTimer = null;
    this.heavyTimer = null;
    this.recoveryTimer = null;
    if (this.supervisor && typeof this.supervisor.stop === 'function') this.supervisor.stop();
  }

  async bootstrap(reason = 'bootstrap') {
    await this.fastPoll(`${reason}-fast`);
    this.heavyPoll(`${reason}-heavy`).catch(()=>{});
    this.recoveryTick(`${reason}-recovery`).catch(()=>{});
    return this.snapshot(reason);
  }

  async poll(reason = 'compatibility-poll') {
    return this.fastPoll(reason);
  }

  markSource(name, patch) {
    const previous = this.runtime.sources[name] || {
      lastStartedAt:null,
      lastCompletedAt:null,
      lastSuccessAt:null,
      lastError:null,
      lastStatus:null,
      durationMs:0,
    };
    this.runtime.sources[name] = {...previous, ...patch};
  }

  async fetchSource(name, pathname, timeoutMs, group = 'default') {
    const started = Date.now();
    this.markSource(name, { lastStartedAt:iso(started) });
    const response = await this.client.get(pathname, { timeoutMs, group });
    const completed = Date.now();
    const patch = {
      lastCompletedAt:iso(completed),
      lastStatus:response.status || 0,
      durationMs:completed-started,
    };
    if (response.ok && response.data && typeof response.data === 'object') {
      patch.lastSuccessAt = iso(completed);
      patch.lastError = null;
      this.markSource(name, patch);
      return { ok:true, data:response.data, status:response.status };
    }
    patch.lastError = summarizeError(response.error || new Error(`${pathname} status=${response.status}`));
    this.markSource(name, patch);
    return { ok:false, data:null, status:response.status || 0, error:patch.lastError };
  }

  expireFastAttempt(reason = 'FAST_ATTEMPT_EXPIRED') {
    this.fastAttemptId += 1;
    this.client.cancelGroup('fast', reason);
    this.fastPolling = false;
    this.runtime.fast.inFlight = false;
    this.runtime.fast.expiredAttempts = finite(this.runtime.fast.expiredAttempts, 0) + 1;
    this.runtime.fast.lastError = { name:'FastAttemptExpired', message:reason, code:reason };
    this.runtime.fast.lastCompletedAt = iso();
    return this.runtimeView();
  }

  async fastPoll(reason = 'manual') {
    const now = Date.now();
    if (this.fastPolling) {
      const ageMs = this.runtime.fast.lastStartedAt
        ? now - timestamp(this.runtime.fast.lastStartedAt)
        : 0;
      if (ageMs <= this.config.fastHardDeadlineMs) return this.snapshot('fast-poll-already-running');
      this.expireFastAttempt('FAST_POLL_ORPHANED_BEYOND_HARD_DEADLINE');
    }

    const attemptId = ++this.fastAttemptId;
    this.fastPolling = true;
    this.runtime.fast.inFlight = true;
    this.runtime.fast.lastStartedAt = iso(now);
    const started = Date.now();

    try {
      const deadline = new Promise(resolve => {
        const timer = setTimeout(() => resolve({ deadline:true }), this.config.fastHardDeadlineMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      const work = Promise.all([
        this.fetchSource('version', '/runner/version', this.config.fastVersionTimeoutMs, 'fast'),
        this.fetchSource('live', '/runner/live', this.config.fastLiveTimeoutMs, 'fast'),
      ]).then(([versionResult, liveResult]) => ({ versionResult, liveResult }));
      const outcome = await Promise.race([work, deadline]);
      if (attemptId !== this.fastAttemptId) return this.snapshot('fast-poll-superseded');
      if (outcome.deadline) {
        this.client.cancelGroup('fast', 'FAST_HARD_DEADLINE');
        this.runtime.fast.sequence += 1;
        this.runtime.fast.consecutiveFailures += 1;
        this.runtime.fast.lastCompletedAt = iso();
        this.runtime.fast.durationMs = Date.now() - started;
        this.runtime.fast.lastError = { name:'FastPollDeadline', message:'Fast poll exceeded hard deadline', code:'FAST_HARD_DEADLINE' };
        return this.snapshot(reason);
      }

      const { versionResult, liveResult } = outcome;
      if (versionResult.ok) this.raw.version = versionResult.data;
      if (liveResult.ok) {
        this.raw.live = liveResult.data;
        this.strategyHeartbeat.observe(liveResult.data, Date.now());
        this.candidateCohortTracker.observe({
          live:liveResult.data,
          candidateAuthority:this.raw.candidateAuthority,
          now:Date.now(),
        });
      }

      this.runtime.fast.sequence += 1;
      this.runtime.fast.lastCompletedAt = iso();
      this.runtime.fast.durationMs = Date.now()-started;

      if (liveResult.ok) {
        this.runtime.fast.lastSuccessAt = iso();
        this.runtime.fast.lastError = versionResult.ok ? null : { version:versionResult.error || null, live:null };
        this.runtime.fast.consecutiveFailures = 0;
      } else {
        this.runtime.fast.consecutiveFailures += 1;
        this.runtime.fast.lastError = {
          version:versionResult.error || null,
          live:liveResult.error || null,
        };
      }

      return this.snapshot(reason);
    } finally {
      if (attemptId === this.fastAttemptId) {
        this.fastPolling = false;
        this.runtime.fast.inFlight = false;
      }
    }
  }

  openHeavyCircuit(reason = 'HEAVY_CIRCUIT_OPENED') {
    this.heavyAttemptId += 1;
    this.client.cancelGroup('heavy', reason);
    this.heavyPolling = false;
    this.runtime.heavy.inFlight = false;
    this.runtime.heavy.cancelledAttempts = finite(this.runtime.heavy.cancelledAttempts, 0) + 1;
    this.heavyCircuitOpenUntil = Date.now() + this.config.heavyCircuitCooldownSec * 1000;
    this.heavyCircuitReason = reason;
    this.runtime.heavy.circuitOpenUntil = iso(this.heavyCircuitOpenUntil);
    this.runtime.heavy.circuitReason = reason;
    this.runtime.heavy.lastError = { name:'HeavyCircuitOpen', message:reason, code:reason };
    return this.runtimeView();
  }

  async afterAdapterRestart(reason = 'ADAPTER_RESTART') {
    this.expireFastAttempt(`RESET_AFTER_${reason}`);
    this.raw.version = null;
    this.raw.live = null;
    this.strategyHeartbeat = new StrategyHeartbeat();
    this.recovery.lastActionAt = null;
    const [watch, lab] = await Promise.all([
      this.client.postJson('/runner/command', { command:'start-watch' }, { timeoutMs:this.config.recoveryCommandTimeoutMs, group:'recovery' }),
      this.client.postJson('/runner/command', { command:'start-lab' }, { timeoutMs:this.config.recoveryCommandTimeoutMs, group:'recovery' }),
    ]);
    this.addRecoveryAction('SUPERVISOR_RESTART_START_WATCH_AND_RESEARCH', {
      ok:watch.ok && lab.ok,
      status:lab.status || watch.status,
      data:{ status:`watch=${watch.ok};lab=${lab.ok}` },
    });
    await this.fastPoll('after-supervised-adapter-restart');
    return this.snapshot('after-supervised-adapter-restart');
  }

  async heavyPoll(reason = 'manual') {
    const now = Date.now();
    if (!this.runtime.fast.lastSuccessAt || !this.adapter.status().running) {
      this.runtime.heavy.lastError = null;
      return this.snapshot('heavy-poll-skipped-waiting-for-fast-health');
    }
    if (this.heavyCircuitOpenUntil > now) {
      this.runtime.heavy.circuitOpenUntil = iso(this.heavyCircuitOpenUntil);
      this.runtime.heavy.circuitReason = this.heavyCircuitReason;
      return this.snapshot('heavy-poll-skipped-circuit-open');
    }
    if (this.heavyCircuitOpenUntil && this.heavyCircuitOpenUntil <= now) {
      this.heavyCircuitOpenUntil = 0;
      this.heavyCircuitReason = null;
      this.runtime.heavy.circuitOpenUntil = null;
      this.runtime.heavy.circuitReason = null;
      this.runtime.heavy.lastError = null;
    }
    if (this.heavyPolling) return this.snapshot('heavy-poll-already-running');

    const attemptId = ++this.heavyAttemptId;
    this.heavyPolling = true;
    this.runtime.heavy.inFlight = true;
    this.runtime.heavy.lastStartedAt = iso();
    const started = Date.now();
    let successCount = 0;
    const errors = {};

    try {
      // v10.2.1 deliberately protects the live strategy process from report endpoints
      // that rebuild thousands of candidate/trade rows. Operational accounting already
      // comes from the fast live authority, persistent candidate cohort, server features,
      // and family-adjusted learning. Legacy row audits are opt-in only.
      if (!this.config.legacyHeavyAuditEnabled) {
        this.runtime.heavy.sequence += 1;
        this.runtime.heavy.lastCompletedAt = iso();
        this.runtime.heavy.lastSuccessAt = iso();
        this.runtime.heavy.lastError = null;
        this.runtime.heavy.durationMs = Date.now() - started;
        this.runtime.heavy.mode = 'HEALTH_PROTECTED_NO_LEGACY_REPORT_REBUILDS';
        this.runtime.heavy.circuitOpenUntil = null;
        this.runtime.heavy.circuitReason = null;
        return this.snapshot(reason);
      }

      const specs = [
        ['candidateAuthority','/runner/candidate-authority.json',20_000],
        ['candleDepth','/runner/candle-depth-authority.json',20_000],
      ];
      for (const [name, pathname, timeoutMs] of specs) {
        if (attemptId !== this.heavyAttemptId) break;
        const fastAge = this.runtime.fast.lastSuccessAt
          ? (Date.now() - timestamp(this.runtime.fast.lastSuccessAt)) / 1000
          : Infinity;
        if (fastAge >= this.config.fastStallSec / 2) {
          errors[name] = { name:'HeavyAuditSkipped', message:'Fast health protection activated', code:'FAST_HEALTH_PROTECTION' };
          break;
        }
        const probe = await this.adapter.probe(this.config.supervisorProbeTimeoutMs);
        if (!probe.ok) {
          errors[name] = probe.error || { name:'ProbeFailed', message:'Adapter probe failed before heavy audit' };
          this.openHeavyCircuit('HEAVY_AUDIT_PRE_PROBE_FAILED');
          break;
        }
        const result = await this.fetchSource(name, pathname, timeoutMs, 'heavy');
        if (attemptId !== this.heavyAttemptId) break;
        if (result.ok) {
          this.raw[name] = result.data;
          successCount += 1;
        } else {
          errors[name] = result.error;
          this.openHeavyCircuit(`HEAVY_SOURCE_FAILED:${name}`);
          break;
        }
      }

      if (attemptId !== this.heavyAttemptId) return this.snapshot('heavy-poll-superseded');
      this.runtime.heavy.sequence += 1;
      this.runtime.heavy.lastCompletedAt = iso();
      this.runtime.heavy.durationMs = Date.now()-started;
      if (successCount > 0) {
        this.runtime.heavy.lastSuccessAt = iso();
        this.runtime.heavy.lastError = Object.keys(errors).length ? errors : null;
      } else if (Object.keys(errors).length) {
        this.runtime.heavy.lastError = errors;
      }
      return this.snapshot(reason);
    } finally {
      if (attemptId === this.heavyAttemptId) {
        this.heavyPolling = false;
        this.runtime.heavy.inFlight = false;
      }
    }
  }

  addRecoveryAction(action, result) {
    const row = {
      at:iso(),
      action,
      ok:Boolean(result && result.ok),
      status:result && result.status || 0,
      responseStatus:text(
        result && result.data &&
        (result.data.status || result.data.message || result.data.error)
      ).slice(0,180),
    };
    this.recovery.lastActionAt = row.at;
    this.recovery.lastAction = action;
    this.recovery.actionCount += 1;
    this.recovery.actions.push(row);
    if (this.recovery.actions.length > 30) {
      this.recovery.actions.splice(0, this.recovery.actions.length-30);
    }
    return row;
  }

  async recoveryTick(reason = 'manual') {
    if (this.recoveryRunning) return this.snapshot('recovery-already-running');
    this.recoveryRunning = true;
    this.runtime.recovery.inFlight = true;
    this.runtime.recovery.lastStartedAt = iso();
    const started = Date.now();

    try {
      const state = this.snapshot('recovery-evaluate');
      const featuresReady = Boolean(
        state.layers.featureEngine &&
        state.layers.featureEngine.ready &&
        state.layers.featureEngine.fresh
      );
      const strategyReady = Boolean(
        state.layers.strategyEngine &&
        state.layers.strategyEngine.ready &&
        state.layers.strategyEngine.fresh
      );
      const sentinelFresh = Boolean(state.layers.sentinel && state.layers.sentinel.fresh);

      if (!this.config.featureRecoveryEnabled) {
        this.recovery.status = 'DISABLED';
        return state;
      }

      if (!featuresReady) {
        this.recovery.status = 'WAITING_FOR_SERVER_FEATURE_ENGINE';
        return state;
      }

      if (!state.layers.process || !state.layers.process.fresh) {
        this.recovery.status = 'SUPERVISOR_OWNS_FAST_HEALTH_RECOVERY';
        return state;
      }

      if (strategyReady && sentinelFresh) {
        this.recovery.status = 'READY_NO_ACTION_REQUIRED';
        return state;
      }

      const now = Date.now();
      const actionAgeSec = this.recovery.lastActionAt
        ? (now-timestamp(this.recovery.lastActionAt))/1000
        : Infinity;
      if (actionAgeSec < this.config.recoveryCooldownSec) {
        this.recovery.status = 'COOLDOWN_AFTER_RECOVERY_ACTION';
        return state;
      }

      let action = null;
      let result = null;
      const live = asObject(this.raw.live);
      const current = asObject(live.currentHealth);
      const rawLabRunning = bool(live.labRunning);
      const researchReady = bool(current.researchReady) || rawLabRunning;
      const sourceAgeSec = this.runtime.fast.lastSuccessAt
        ? (now-timestamp(this.runtime.fast.lastSuccessAt))/1000
        : Infinity;

      if (this.config.autoStartResearch && (!rawLabRunning || !researchReady || this.recovery.actionCount === 0)) {
        action = 'START_WATCH_AND_RESEARCH';
        const [watch, lab] = await Promise.all([
          this.client.postJson('/runner/command', { command:'start-watch' }, { timeoutMs:this.config.recoveryCommandTimeoutMs, group:'recovery' }),
          this.client.postJson('/runner/command', { command:'start-lab' }, { timeoutMs:this.config.recoveryCommandTimeoutMs, group:'recovery' }),
        ]);
        result = {
          ok:watch.ok && lab.ok,
          status:lab.status || watch.status,
          data:{ status:`watch=${watch.ok};lab=${lab.ok}` },
        };
      } else if (
        sourceAgeSec >= this.config.recoveryReloadSec &&
        this.recovery.reloadCount < 1
      ) {
        action = 'CONTROLLED_BROWSER_RELOAD_AFTER_PROLONGED_SOURCE_STALL';
        result = await this.client.postJson(
          '/runner/command',
          { command:'reload' },
          { timeoutMs:this.config.recoveryCommandTimeoutMs }
        );
        this.recovery.reloadCount += 1;
      } else {
        action = 'RESEARCH_OR_SENTINEL_WATCHDOG';
        result = await this.client.postJson(
          '/runner/command',
          { command:'watchdog' },
          { timeoutMs:this.config.recoveryCommandTimeoutMs }
        );
      }

      this.addRecoveryAction(action, result);
      this.recovery.status = result && result.ok
        ? 'RECOVERY_ACTION_ACCEPTED'
        : 'RECOVERY_ACTION_FAILED';
      this.log(`[v10.2.1] recovery ${action} ok=${Boolean(result && result.ok)} reason=${reason}`);
      this.fastPoll('after-recovery-action').catch(()=>{});
      return this.snapshot(reason);
    } catch (error) {
      this.recovery.status = 'RECOVERY_ERROR';
      this.runtime.recovery.lastError = summarizeError(error);
      throw error;
    } finally {
      this.recoveryRunning = false;
      this.runtime.recovery.inFlight = false;
      this.runtime.recovery.sequence += 1;
      this.runtime.recovery.lastCompletedAt = iso();
      this.runtime.recovery.durationMs = Date.now()-started;
      if (!this.runtime.recovery.lastError) this.runtime.recovery.lastSuccessAt = iso();
    }
  }

  snapshot(reason = 'snapshot', now = Date.now()) {
    this.state = this.buildState(reason, now);
    return this.state;
  }

  buildState(reason, now = Date.now()) {
    const live = asObject(this.raw.live);
    const current = asObject(live.currentHealth);
    const learning = asObject(live.adaptiveEvidenceLearning || current.adaptiveEvidenceLearning);
    const serverFeatures = this.featureEngine ? this.featureEngine.view(now) : null;
    const adapterStatus = this.adapter.status();
    const strategyHeartbeat = this.strategyHeartbeat.view();
    const candidateCohort = this.candidateCohortTracker.view();

    const candidateVisibilityAudit = auditCandidateVisibility({
      nativeView:this.raw.nativePool,
      currentHealth:current,
      legacyPaperSeen:finite(live.paperEntryVisibilityCandidatesSeen,0),
    });

    const layers = deriveFreshness({
      legacyVersion:this.raw.version,
      live,
      candidateAuthority:this.raw.candidateAuthority,
      candleDepth:this.raw.candleDepth,
      chartTruth:this.raw.chartTruth,
      serverFeatures,
      runtimeMeta:{
        fastLastSuccessAt:this.runtime.fast.lastSuccessAt,
        liveLastSuccessAt:this.runtime.sources.live && this.runtime.sources.live.lastSuccessAt,
        versionLastSuccessAt:this.runtime.sources.version && this.runtime.sources.version.lastSuccessAt,
      },
      adapterStatus,
      strategyHeartbeat,
      candidateCohort,
      now,
      config:this.config,
    });

    const candidateAccounting = buildCandidateAccounting({
      live,
      candidateAuthority:this.raw.candidateAuthority,
      candidateVisibilityAudit,
      candidateCohort,
    });
    const familyAdjustedStats = buildFamilyAdjustedStats({
      trades:this.raw.trades,
      learning,
    });

    const paperLifecyclePass = Boolean(
      layers.process.fresh &&
      layers.sentinel.fresh &&
      layers.paperEntry.fresh &&
      layers.candidatePipeline.fresh
    );
    const researchPass = Boolean(
      layers.process.fresh &&
      layers.candleBank.fresh &&
      layers.featureEngine.fresh &&
      layers.strategyEngine.fresh &&
      layers.researchCycle.fresh &&
      layers.candidatePipeline.fresh
    );
    const candidateAccountingPass = Boolean(candidateAccounting.pass);
    const chartPass = Boolean(layers.chart.fresh);
    const learningPass = Boolean(
      layers.learning.fresh &&
      familyAdjustedStats.independentFamilies > 0
    );
    const autonomyAuthority = this.deriveAutonomyAuthority({
      layers,
      candidateAccounting,
      familyAdjustedStats,
      paperLifecyclePass,
      researchPass,
      learningPass,
      chartPass,
      live,
      current,
    });
    candidateAccounting.fullAutonomy = autonomyAuthority;
    const autonomyPass = Boolean(autonomyAuthority.pass);
    const overallPass = Boolean(
      paperLifecyclePass &&
      researchPass &&
      candidateAccountingPass &&
      learningPass &&
      chartPass &&
      autonomyPass
    );

    const gates = {
      paperLifecycle:{
        status:paperLifecyclePass?'PASS':'WARN',
        pass:paperLifecyclePass,
        requiredLayers:['process','sentinel','paperEntry','candidatePipeline'],
      },
      research:{
        status:researchPass?'PASS':'WARN',
        pass:researchPass,
        requiredLayers:['process','candleBank','featureEngine','strategyEngine','researchCycle','candidatePipeline'],
      },
      candidateAccounting:{
        status:candidateAccountingPass?'PASS':'WARN',
        pass:candidateAccountingPass,
        unresolvedDiscoveryToLatch:candidateAccounting.transitions.discoveryToLatchUnresolved,
        paperVisibilityStatus:candidateAccounting.transitions.paperVisibilityStatus,
        paperVisibilityComparableCohort:candidateAccounting.transitions.paperVisibilityComparableCohort,
        paperVisibilityObservationDelta:candidateAccounting.transitions.paperVisibilityObservationDelta,
        cohortStatus:candidateAccounting.cohort && candidateAccounting.cohort.status,
        persistentGapConfirmed:Boolean(candidateAccounting.cohort && candidateAccounting.cohort.persistentGapConfirmed),
        transientGap:candidateAccounting.transitions.discoveryToLatchTransient,
      },
      learning:{
        status:learningPass?'PASS':'WARN',
        pass:learningPass,
        independentFamilies:familyAdjustedStats.independentFamilies,
        authority:familyAdjustedStats.source,
      },
      autonomy:{
        status:autonomyPass?'PASS':'INACTIVE',
        pass:autonomyPass,
        authority:autonomyAuthority,
      },
      chart:{ status:chartPass?'PASS':'WARN', pass:chartPass },
      overall:{
        status:overallPass?'PASS':'WARN',
        pass:overallPass,
        nextRequiredAction:overallPass
          ? 'OBSERVE_AND_LEARN'
          : this.nextAction({ layers, candidateAccounting, familyAdjustedStats, adapterStatus }),
      },
    };

    const rawStats = asObject(current.closedLedgerStats);
    const metrics = {
      candidates:finite(live.candidates,0),
      nativePoolCandidates:finite(live.nativePoolCandidates,0),
      forwardLatchSize:finite(live.forwardLatchSize,0),
      paperVisibilitySeen:finite(live.paperEntryVisibilityCandidatesSeen,0),
      pendingEntries:finite(current.pendingEntries,0),
      openPositions:finite(live.openPositions,0),
      rawClosedTrades:finite(live.closedTrades,0),
      featureRowsFound:finite(serverFeatures && serverFeatures.featureRowsFound,0),
      freshFeaturePairFrames:finite(serverFeatures && serverFeatures.freshFeaturePairFrames,0),
      requiredFeaturePairFrames:finite(
        serverFeatures && serverFeatures.requiredPairFrames,
        this.config.expectedPairFrames
      ),
      legacyFeatureRowsFound:finite(live.featureRowsFound,0),
      legacyFreshFeaturePairFrames:finite(live.freshFeaturePairFrames,0),
      rawLedgerStats:{
        closedTrades:finite(rawStats.closedTrades, live.closedTrades || 0),
        wins:finite(rawStats.wins,current.wins||0),
        losses:finite(rawStats.losses,current.losses||0),
        breakeven:finite(rawStats.breakeven,current.breakeven||0),
        winRate:finite(rawStats.winRate,current.winRate||0),
        profitFactorR:rawStats.profitFactorR ?? current.profitFactorR ?? null,
      },
      familyAdjustedStats:{
        source:familyAdjustedStats.source,
        independentFamilies:familyAdjustedStats.independentFamilies,
        wins:familyAdjustedStats.wins,
        losses:familyAdjustedStats.losses,
        breakeven:familyAdjustedStats.breakeven,
        winRate:familyAdjustedStats.winRate,
        profitFactorR:familyAdjustedStats.profitFactorR,
        avgResultR:familyAdjustedStats.avgResultR,
      },
    };

    return {
      schema:'alps.v10200.unifiedState.v3',
      version:this.config.version,
      generatedAt:iso(now),
      reason,
      status:overallPass?'LAB_RUNNING':'PARTIAL_OPERATION',
      labRunning:overallPass,
      researchReady:researchPass,
      paperLifecycleRunning:paperLifecyclePass,
      execution:{ paperOnly:true, liveCapitalExecution:false, testnetExecution:false },
      adapter:{
        ...adapterStatus,
        sourceVersion:text(this.raw.version && this.raw.version.version),
        sourceProcessInstanceId:text(this.raw.version && this.raw.version.processInstanceId),
      },
      runtime:this.runtimeView(),
      layers,
      gates,
      metrics,
      candidateAccounting,
      candidateCohort,
      strategyHeartbeat,
      autonomyAuthority,
      candidateVisibilityAudit,
      serverFeatures,
      familyAdjustedStats,
      learning:{
        status:text(learning.status,'NOT_READY'),
        generatedAt:learning.generatedAt || null,
        source:learning.source || null,
        independentExperimentFamilies:finite(learning.independentExperimentFamilies,0),
        rawValidClosedTrades:finite(learning.rawValidClosedTrades,0),
        correlatedSiblingTradesCollapsed:finite(learning.correlatedSiblingTradesCollapsed,0),
        actions:asArray(learning.learningActions),
        pairConfidence:asArray(learning.pairConfidence),
        timeframeConfidence:asArray(learning.timeframeConfidence),
        appliedToCandidatePriority:bool(learning.appliedToCandidatePriority),
        appliedAsHardFilter:bool(learning.appliedToExecutionAsHardFilter),
      },
      lifecycle:{
        sentinelRuntimeStatus:text(current.sentinelRuntimeStatus,'UNKNOWN'),
        sentinelLastTickAt:current.sentinelLastTickAt || null,
        sentinelConsecutiveFailures:finite(current.sentinelConsecutiveFailures,0),
        watchedOpenTrades:finite(current.watchedOpenTrades,0),
        watchedPendingEntries:finite(current.watchedPendingEntries,0),
        priceSourceSummary:this.priceSourceSummary(current),
        openPositions:finite(live.openPositions,0),
        closedTrades:finite(live.closedTrades,0),
        pendingEntries:finite(current.pendingEntries,0),
        lastCheckResult:text(current.lastCheckResult),
        closeWritebackStatus:text(current.closeWritebackStatus),
      },
      recovery:{...this.recovery},
      sourceTruth:{
        adapterEndpoint:'/internal/runner/live',
        sourceVersion:text(live.version),
        sourceGeneratedAt:live.generatedAt || null,
        sourceCurrentHealthFresh:bool(live.currentHealthFresh),
        sourceCurrentHealthAgeSec:finite(live.currentHealthAgeSec,0),
        serverFeatureAuthority:serverFeatures && serverFeatures.status || 'NOT_AVAILABLE',
        fastPollLastSuccessAt:this.runtime.fast.lastSuccessAt,
        heavyPollLastSuccessAt:this.runtime.heavy.lastSuccessAt,
        runtimeSupervisor:this.supervisor ? this.supervisor.status() : null,
      },
      lastError:{
        fast:this.runtime.fast.lastError,
        heavy:this.runtime.heavy.lastError,
        recovery:this.runtime.recovery.lastError,
      },
    };
  }

  deriveAutonomyAuthority({
    layers,
    candidateAccounting,
    familyAdjustedStats,
    paperLifecyclePass,
    researchPass,
    learningPass,
    chartPass,
    live,
    current,
  }) {
    const candidates = Math.max(0, finite(live.candidates, 0));
    const nativePool = Math.max(0, finite(live.nativePoolCandidates, 0));
    const latch = Math.max(0, finite(live.forwardLatchSize, 0));
    const engineHookActive = Boolean(layers.strategyEngine && layers.strategyEngine.fresh);
    const nativePoolOverrideApplied = Boolean(
      candidateAccounting.pass &&
      candidates > 0 &&
      nativePool > 0 &&
      latch > 0 &&
      nativePool <= candidates &&
      latch <= nativePool
    );
    const softPriorityLearningActive = Boolean(
      learningPass &&
      familyAdjustedStats.independentFamilies > 0
    );
    const active = Boolean(
      paperLifecyclePass &&
      researchPass &&
      candidateAccounting.pass &&
      chartPass &&
      engineHookActive &&
      nativePoolOverrideApplied &&
      softPriorityLearningActive
    );
    const legacyForwarded = Math.max(0, finite(current.fullAutonomyForward, 0));
    return {
      schema:'alps.v10200.fullAutonomyAuthority.v1',
      mode:'FULL_AUTONOMY_PAPER_FORWARD_CONTROL_PLANE',
      status:active ? 'FULL_AUTONOMY_PAPER_FORWARD_ACTIVE' : 'WAITING_FOR_FULL_AUTONOMY_PREREQUISITES',
      active,
      pass:active,
      engineHookActive,
      nativePoolOverrideApplied,
      softPriorityLearningActive,
      noFixedCandidateCap:true,
      noHardLearningBans:true,
      candidatesAccepted:candidates,
      nativePoolCandidates:nativePool,
      forwardedToLatch:latch,
      eligible:active ? latch : 0,
      inFlight:Math.max(0, candidates-latch),
      blocked:active ? 0 : Math.max(0, candidates-latch),
      legacyAutonomyForwarded:legacyForwarded,
      paperOnly:true,
      liveCapitalExecution:false,
      testnetExecution:false,
      rule:'The v10.2.0 control plane treats the reconciled Native Pool and Forward Latch as the paper-forward autonomy authority. Legacy autonomy labels cannot block a fully reconciled uncapped paper flow.'
    };
  }

  priceSourceSummary(current) {
    const counts = {};
    for (const row of asArray(current.livePriceFetchProof)) {
      const source = text(row.source,'UNKNOWN');
      counts[source]=(counts[source]||0)+1;
    }
    return counts;
  }

  nextAction({ layers, candidateAccounting, familyAdjustedStats, adapterStatus }) {
    if (!adapterStatus.running) return 'RESTART_ISOLATED_BROWSER_ENGINE_ADAPTER';
    if (!layers.process.fresh) return 'RECOVER_CONTROL_PLANE_FAST_HEALTH_POLL';
    if (!layers.candleBank.fresh) return 'RECOVER_CANONICAL_CANDLE_BANK';
    if (!layers.featureEngine.fresh) return 'RECOVER_SERVER_FEATURE_ENGINE';
    if (!layers.researchCycle.fresh) return 'RECOVER_RESEARCH_CYCLE';
    if (!candidateAccounting.pass) return 'RECONCILE_DISCOVERY_NATIVE_LATCH_PIPELINE';
    if (!layers.sentinel.fresh) return 'RECOVER_PRICE_SENTINEL';
    if (familyAdjustedStats.independentFamilies === 0) return 'WAIT_FOR_CURRENT_EPOCH_INDEPENDENT_CLOSES';
    if (!layers.chart.fresh) return 'RECOVER_CHART_TRUTH';
    if (!candidateAccounting.fullAutonomy || !candidateAccounting.fullAutonomy.active) return 'ACTIVATE_FULL_AUTONOMY_PAPER_FORWARD_AUTHORITY';
    return 'REVIEW_LAYER_WARNINGS';
  }

  compactLive() {
    const s = this.snapshot('live-response');
    return {
      schema:'alps.v10200.liveSummary.v3',
      version:this.config.version,
      generatedAt:s.generatedAt,
      status:s.status,
      labRunning:s.labRunning,
      researchReady:s.researchReady,
      paperLifecycleRunning:s.paperLifecycleRunning,
      execution:s.execution,
      layers:s.layers,
      gates:s.gates,
      metrics:s.metrics,
      candidateAccounting:{
        status:s.candidateAccounting && s.candidateAccounting.status,
        pass:s.candidateAccounting && s.candidateAccounting.pass,
        transitions:s.candidateAccounting && s.candidateAccounting.transitions,
        audit:s.candidateAccounting && s.candidateAccounting.audit,
        fullAutonomy:s.candidateAccounting && s.candidateAccounting.fullAutonomy,
      },
      featureAuthority:s.serverFeatures ? {
        status:s.serverFeatures.status,
        ready:s.serverFeatures.ready,
        featureRowsFound:s.serverFeatures.featureRowsFound,
        freshFeaturePairFrames:s.serverFeatures.freshFeaturePairFrames,
        requiredPairFrames:s.serverFeatures.requiredPairFrames,
        lastRefreshCompletedAt:s.serverFeatures.lastRefreshCompletedAt,
      } : null,
      learning:{
        status:s.learning && s.learning.status,
        independentExperimentFamilies:s.learning && s.learning.independentExperimentFamilies,
        familyAdjustedAuthority:s.familyAdjustedStats && s.familyAdjustedStats.source,
        familyAdjustedFamilies:s.familyAdjustedStats && s.familyAdjustedStats.independentFamilies,
        actions:s.learning && s.learning.actions,
      },
      strategyHeartbeat:s.strategyHeartbeat,
      candidateCohort:s.candidateCohort,
      autonomyAuthority:s.autonomyAuthority,
      lifecycle:s.lifecycle,
      recovery:s.recovery,
      runtime:s.runtime,
      adapter:s.adapter,
      sourceTruth:s.sourceTruth,
      endpoints:{
        features:'/runner/features',
        candidates:'/runner/candidates',
        lifecycle:'/runner/lifecycle',
        learning:'/runner/learning',
        ledgerStats:'/runner/ledger-stats',
        selfTest:'/runner/self-test',
        acceptance:'/runner/acceptance',
        autonomy:'/runner/autonomy',
        candidateCohort:'/runner/candidate-cohort',
      },
      rule:'LAB_RUNNING requires independent strategy heartbeat, fresh research and paper lifecycle, persistent-cohort candidate accounting, family learning, chart truth and active full-autonomy paper-forward authority.',
    };
  }

  selfTest() {
    const s = this.snapshot('self-test');
    const distinct = s.layers && s.layers.sentinel && s.layers.featureEngine &&
      s.layers.sentinel.evidenceField !== s.layers.featureEngine.evidenceField;
    const nonBlocking = Boolean(
      s.runtime &&
      s.runtime.architecture === 'SUPERVISED_FAST_HEALTH_PLUS_NON_BLOCKING_AUTHORITY_REFRESH_PLUS_INDEPENDENT_RECOVERY'
    );
    const noFalsePass = !(s.gates && s.gates.overall && s.gates.overall.pass) ||
      (s.researchReady && s.paperLifecycleRunning && s.gates.candidateAccounting.pass && s.gates.learning.pass && s.gates.chart.pass && s.gates.autonomy.pass);
    const compactBytes = Buffer.byteLength(JSON.stringify(this.compactLive()));
    const architecturePass = Boolean(
      distinct &&
      nonBlocking &&
      noFalsePass &&
      s.candidateAccounting &&
      s.candidateCohort &&
      s.strategyHeartbeat &&
      s.autonomyAuthority &&
      s.familyAdjustedStats &&
      s.serverFeatures &&
      compactBytes <= this.config.liveSummaryMaxBytes &&
      s.execution &&
      s.execution.paperOnly &&
      !s.execution.liveCapitalExecution &&
      !s.execution.testnetExecution
    );
    return {
      schema:'alps.v10200.architectureSelfTest.v3',
      version:this.config.version,
      generatedAt:iso(),
      browserEngineIsolated:this.adapter.status().mode==='ISOLATED_LEGACY_BROWSER_ENGINE_ADAPTER',
      independentLayerFreshness:Boolean(distinct),
      nonBlockingRuntimeWorkers:nonBlocking,
      sentinelCannotMaskFeatureFailure:Boolean(
        s.layers && (!s.layers.sentinel.fresh || s.layers.featureEngine.fresh || !s.researchReady)
      ),
      overallPassCannotIgnoreResearch:Boolean(noFalsePass),
      candidateAccountingPublished:Boolean(s.candidateAccounting && s.candidateAccounting.transitions),
      strategyHeartbeatPublished:Boolean(s.strategyHeartbeat && s.strategyHeartbeat.schema),
      candidateCohortAuthorityPublished:Boolean(s.candidateCohort && s.candidateCohort.schema),
      fullAutonomyAuthorityPublished:Boolean(s.autonomyAuthority && s.autonomyAuthority.schema),
      runtimeSupervisorPublished:Boolean(s.runtime && s.runtime.supervisor && s.runtime.supervisor.schema),
      serverFeatureAuthorityPublished:Boolean(s.serverFeatures && s.serverFeatures.schema),
      familyAdjustedPerformancePublished:Boolean(
        s.familyAdjustedStats && typeof s.familyAdjustedStats.independentFamilies==='number'
      ),
      liveSummaryCompact:compactBytes <= this.config.liveSummaryMaxBytes,
      liveSummaryBytes:compactBytes,
      paperOnly:s.execution && s.execution.paperOnly===true,
      liveCapitalExecution:s.execution && s.execution.liveCapitalExecution===true,
      testnetExecution:s.execution && s.execution.testnetExecution===true,
      operationalAcceptanceEndpoint:'/runner/acceptance',
      architecturePass,
      pass:architecturePass,
    };
  }

  operationalAcceptance() {
    const s = this.snapshot('operational-acceptance');
    const requiredFresh = [
      'process','candleBank','featureEngine','strategyEngine','researchCycle',
      'candidatePipeline','paperEntry','sentinel','learning','chart',
    ];
    const staleOrNotReady = requiredFresh.filter(name => !(s.layers[name] && s.layers[name].fresh));
    const pass = Boolean(
      staleOrNotReady.length === 0 &&
      s.gates.overall.pass &&
      s.gates.candidateAccounting.pass &&
      s.gates.autonomy.pass &&
      s.metrics.featureRowsFound >= s.metrics.requiredFeaturePairFrames &&
      s.familyAdjustedStats.independentFamilies > 0
    );
    return {
      schema:'alps.v10200.operationalAcceptance.v2',
      version:this.config.version,
      generatedAt:iso(),
      pass,
      status:pass?'PASS':'WARN',
      staleOrNotReady,
      gates:s.gates,
      featureCoverage:{
        found:s.metrics.featureRowsFound,
        required:s.metrics.requiredFeaturePairFrames,
      },
      familyAdjustedFamilies:s.familyAdjustedStats.independentFamilies,
      strategyHeartbeat:s.strategyHeartbeat,
      candidateCohort:s.candidateCohort,
      autonomyAuthority:s.autonomyAuthority,
      nextRequiredAction:s.gates.overall.nextRequiredAction,
      rule:'Strict acceptance requires every operational layer fresh, no confirmed persistent candidate gap, independent family learning, and active full-autonomy paper-forward authority.',
    };
  }

  async forceResearchRecovery() {
    this.recovery.lastActionAt = null;
    await this.recoveryTick('manual-force-recovery');
    this.fastPoll('after-manual-force-recovery').catch(()=>{});
    return this.snapshot('after-manual-force-recovery');
  }
}

module.exports = { UnifiedOrchestrator };
