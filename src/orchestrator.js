'use strict';

const { deriveFreshness } = require('./freshness');
const { buildCandidateAccounting } = require('./candidate-accounting');
const { buildFamilyAdjustedStats } = require('./family-stats');
const { auditCandidateVisibility } = require('./candidate-visibility-auditor');
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
    this.timer = null;
    this.polling = false;
    this.pollSeq = 0;
    this.lastPollAt = null;
    this.lastPollError = null;
    this.raw = { version:null, live:null, trades:null, candidateAuthority:null, candleDepth:null, chartTruth:null, nativePool:null };
    this.state = this.emptyState();
    this.featureRecovery = {
      status:'IDLE', missingSince:null, lastProgressAt:null, lastFeatureRows:0,
      lastActionAt:null, lastAction:null, actionCount:0, reloadCount:0, actions:[],
    };
    this.lastTradesClosedCount = -1;
    this.lastTradesFetchAt = 0;
    this.lastNativePoolFetchAt = 0;
    this.lastNativePoolCandidateCount = -1;
  }

  emptyState() {
    return {
      schema:'alps.v10200.unifiedState.v1', version:this.config.version, generatedAt:iso(),
      status:'BOOTING', labRunning:false, researchReady:false, paperLifecycleRunning:false,
      layers:{}, gates:{}, candidateAccounting:null, familyAdjustedStats:null,
      metrics:{}, recovery:{}, adapter:this.adapter.status(), lastError:null,
    };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll('interval').catch(error => this.log('[v10.2.0] poll error', summarizeError(error))), this.config.pollMs);
    this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async fetchJson(pathname, required = false, timeoutMs = 30_000) {
    const response = await this.client.get(pathname, { timeoutMs });
    if (!response.ok && required) throw new Error(`${pathname} failed status=${response.status}: ${JSON.stringify(response.error || response.data).slice(0,300)}`);
    return response.ok && response.data && typeof response.data === 'object' ? response.data : null;
  }

  async refreshTrades(live) {
    const closed = finite(live && live.closedTrades, -1);
    const due = Date.now() - this.lastTradesFetchAt > 60_000;
    if (!this.raw.trades || closed !== this.lastTradesClosedCount || due) {
      const trades = await this.fetchJson('/runner/trades.json', false, 45_000);
      if (trades) {
        this.raw.trades = trades;
        this.lastTradesClosedCount = closed;
        this.lastTradesFetchAt = Date.now();
      }
    }
  }

  async refreshNativePool(live) {
    const count = finite(live && live.nativePoolCandidates, -1);
    const due = Date.now() - this.lastNativePoolFetchAt > 60_000;
    if (!this.raw.nativePool || count !== this.lastNativePoolCandidateCount || due) {
      const view = await this.fetchJson('/runner/native-forward-pool.json', false, 60_000);
      if (view) {
        this.raw.nativePool = view;
        this.lastNativePoolCandidateCount = count;
        this.lastNativePoolFetchAt = Date.now();
      }
    }
  }

  async poll(reason = 'manual') {
    if (this.polling) return this.state;
    this.polling = true;
    const started = Date.now();
    try {
      const version = await this.fetchJson('/runner/version', true, 10_000);
      const live = await this.fetchJson('/runner/live', true, 45_000);
      const [candidateAuthority, candleDepth, chartTruth] = await Promise.all([
        this.fetchJson('/runner/candidate-authority.json', false, 30_000),
        this.fetchJson('/runner/candle-depth-authority.json', false, 30_000),
        this.fetchJson('/runner/chart-truth.json', false, 30_000),
      ]);
      this.raw.version = version;
      this.raw.live = live;
      if (candidateAuthority) this.raw.candidateAuthority = candidateAuthority;
      if (candleDepth) this.raw.candleDepth = candleDepth;
      if (chartTruth) this.raw.chartTruth = chartTruth;
      await Promise.all([this.refreshTrades(live), this.refreshNativePool(live)]);
      await this.maybeRecoverFeatures(live, reason);
      this.state = this.buildState(reason);
      this.pollSeq += 1;
      this.lastPollAt = iso();
      this.lastPollError = null;
      return this.state;
    } catch (error) {
      this.lastPollError = summarizeError(error);
      this.state = {
        ...this.state,
        generatedAt:iso(), status:'ADAPTER_UNREACHABLE', labRunning:false, researchReady:false,
        paperLifecycleRunning:false, lastError:this.lastPollError,
        adapter:this.adapter.status(),
      };
      throw error;
    } finally {
      this.polling = false;
      this.state.poll = { sequence:this.pollSeq, reason, startedAt:iso(started), durationMs:Date.now()-started, lastCompletedAt:this.lastPollAt };
    }
  }

  addRecoveryAction(action, result) {
    const row = { at:iso(), action, ok:Boolean(result && result.ok), status:result && result.status || 0,
      responseStatus:text(result && result.data && (result.data.status || result.data.message || result.data.error)).slice(0,180) };
    this.featureRecovery.lastActionAt = row.at;
    this.featureRecovery.lastAction = action;
    this.featureRecovery.actionCount += 1;
    this.featureRecovery.actions.push(row);
    if (this.featureRecovery.actions.length > 40) this.featureRecovery.actions.splice(0, this.featureRecovery.actions.length - 40);
    return row;
  }

  async maybeRecoverFeatures(live, reason) {
    if (!this.config.featureRecoveryEnabled || !live) return;
    const current = asObject(live.currentHealth);
    const required = Math.max(1, finite(live.requiredFeaturePairFrames, this.config.expectedPairFrames));
    const fresh = Math.max(0, finite(live.freshFeaturePairFrames, 0));
    const candles = Math.max(0, finite(current.canonicalCandlePairFrames, 0));
    const missing = fresh < required;
    const now = Date.now();

    if (!missing) {
      this.featureRecovery = { ...this.featureRecovery, status:'FEATURE_EPOCH_READY', missingSince:null, lastProgressAt:iso(), lastFeatureRows:fresh };
      return;
    }
    if (!this.featureRecovery.missingSince) this.featureRecovery.missingSince = iso();
    if (fresh > this.featureRecovery.lastFeatureRows) {
      this.featureRecovery.lastProgressAt = iso();
      this.featureRecovery.lastFeatureRows = fresh;
    }
    const missingAge = (now - timestamp(this.featureRecovery.missingSince)) / 1000;
    const actionAge = this.featureRecovery.lastActionAt ? (now - timestamp(this.featureRecovery.lastActionAt))/1000 : Infinity;
    this.featureRecovery.status = candles >= required ? 'RECOVERING_FEATURE_EPOCH_FROM_CANONICAL_CANDLES' : 'WAITING_FOR_CANONICAL_CANDLES';

    if (candles < required || actionAge < 12) return;

    let action = null;
    let result = null;
    if (this.config.autoStartResearch && this.featureRecovery.actionCount === 0) {
      action = 'START_WATCH_AND_RESEARCH';
      const watch = await this.client.postJson('/runner/command', { command:'start-watch' }, { timeoutMs:45_000 });
      const lab = await this.client.postJson('/runner/command', { command:'start-lab' }, { timeoutMs:45_000 });
      result = { ok:watch.ok && lab.ok, status:lab.status || watch.status, data:{ status:`watch=${watch.ok};lab=${lab.ok}` } };
    } else if (missingAge >= this.config.featureRecoveryReloadSec && this.featureRecovery.reloadCount < 1) {
      action = 'CONTROLLED_BROWSER_RELOAD_AFTER_NO_FEATURE_PROGRESS';
      result = await this.client.postJson('/runner/command', { command:'reload' }, { timeoutMs:90_000 });
      this.featureRecovery.reloadCount += 1;
    } else if (missingAge >= this.config.featureRecoveryWatchdogSec && actionAge >= this.config.featureRecoveryWatchdogSec) {
      action = 'RESEARCH_WATCHDOG_RECOVERY';
      result = await this.client.postJson('/runner/command', { command:'watchdog' }, { timeoutMs:60_000 });
    } else if (missingAge >= this.config.featureRecoverySoftSec && actionAge >= this.config.featureRecoverySoftSec) {
      action = 'QUEUE_FEATURE_MATERIALIZER_VIA_HEALTH';
      result = await this.client.get('/runner/health', { timeoutMs:60_000 });
    }
    if (action) {
      this.addRecoveryAction(action, result);
      this.log(`[v10.2.0] feature recovery ${action} ok=${Boolean(result && result.ok)} reason=${reason}`);
    }
  }

  buildState(reason, now = Date.now()) {
    const live = asObject(this.raw.live);
    const current = asObject(live.currentHealth);
    const learning = asObject(live.adaptiveEvidenceLearning || current.adaptiveEvidenceLearning);
    const serverFeatures = this.featureEngine ? this.featureEngine.view(now) : null;
    const candidateVisibilityAudit = auditCandidateVisibility({ nativeView:this.raw.nativePool, currentHealth:current, legacyPaperSeen:finite(live.paperEntryVisibilityCandidatesSeen,0) });
    const layers = deriveFreshness({
      legacyVersion:this.raw.version, live, candidateAuthority:this.raw.candidateAuthority,
      candleDepth:this.raw.candleDepth, chartTruth:this.raw.chartTruth, serverFeatures, now, config:this.config,
    });
    const candidateAccounting = buildCandidateAccounting({ live, candidateAuthority:this.raw.candidateAuthority, candidateVisibilityAudit });
    const familyAdjustedStats = buildFamilyAdjustedStats({ trades:this.raw.trades, learning });

    const paperLifecyclePass = Boolean(layers.process.fresh && layers.sentinel.fresh && layers.paperEntry.fresh && finite(live.forwardLatchSize,0)>0);
    const researchPass = Boolean(layers.process.fresh && layers.candleBank.fresh && layers.featureEngine.fresh && layers.strategyEngine.fresh && layers.researchCycle.fresh && layers.candidatePipeline.fresh);
    const candidateAccountingPass = candidateAccounting.transitions.discoveryToLatchUnresolved === 0 && candidateAccounting.transitions.latchToPaperVisibilityUnresolved === 0;
    const autonomyPass = Boolean(researchPass && candidateAccounting.fullAutonomy.active && candidateAccounting.fullAutonomy.eligible > 0);
    const chartPass = Boolean(layers.chart.fresh);
    const learningPass = Boolean(layers.learning.fresh && familyAdjustedStats.independentFamilies > 0);
    const overallPass = Boolean(paperLifecyclePass && researchPass && candidateAccountingPass && learningPass && chartPass);

    const gates = {
      paperLifecycle:{ status:paperLifecyclePass?'PASS':'WARN', pass:paperLifecyclePass, requiredLayers:['process','sentinel','paperEntry','candidatePipeline'] },
      research:{ status:researchPass?'PASS':'WARN', pass:researchPass, requiredLayers:['process','candleBank','featureEngine','strategyEngine','researchCycle','candidatePipeline'] },
      candidateAccounting:{ status:candidateAccountingPass?'PASS':'WARN', pass:candidateAccountingPass,
        unresolvedDiscoveryToLatch:candidateAccounting.transitions.discoveryToLatchUnresolved,
        unresolvedLatchToPaperVisibility:candidateAccounting.transitions.latchToPaperVisibilityUnresolved },
      learning:{ status:learningPass?'PASS':'WARN', pass:learningPass, independentFamilies:familyAdjustedStats.independentFamilies },
      autonomy:{ status:autonomyPass?'PASS':'INACTIVE', pass:autonomyPass },
      chart:{ status:chartPass?'PASS':'WARN', pass:chartPass },
      overall:{ status:overallPass?'PASS':'WARN', pass:overallPass,
        nextRequiredAction:overallPass ? 'OBSERVE_AND_LEARN' : this.nextAction({ layers, candidateAccounting, familyAdjustedStats }) },
    };

    const rawStats = asObject(current.closedLedgerStats);
    const metrics = {
      candidates:finite(live.candidates,0), nativePoolCandidates:finite(live.nativePoolCandidates,0), forwardLatchSize:finite(live.forwardLatchSize,0),
      paperVisibilitySeen:finite(live.paperEntryVisibilityCandidatesSeen,0), pendingEntries:finite(current.pendingEntries,0),
      openPositions:finite(live.openPositions,0), rawClosedTrades:finite(live.closedTrades,0),
      featureRowsFound:finite(serverFeatures && serverFeatures.featureRowsFound,0), freshFeaturePairFrames:finite(serverFeatures && serverFeatures.freshFeaturePairFrames,0), requiredFeaturePairFrames:finite(serverFeatures && serverFeatures.requiredPairFrames,this.config.expectedPairFrames),
      legacyFeatureRowsFound:finite(live.featureRowsFound,0), legacyFreshFeaturePairFrames:finite(live.freshFeaturePairFrames,0),
      rawLedgerStats:{ closedTrades:finite(rawStats.closedTrades, live.closedTrades || 0), wins:finite(rawStats.wins,current.wins||0), losses:finite(rawStats.losses,current.losses||0), breakeven:finite(rawStats.breakeven,current.breakeven||0), winRate:finite(rawStats.winRate,current.winRate||0), profitFactorR:rawStats.profitFactorR ?? current.profitFactorR ?? null },
      familyAdjustedStats:{ independentFamilies:familyAdjustedStats.independentFamilies, wins:familyAdjustedStats.wins, losses:familyAdjustedStats.losses, breakeven:familyAdjustedStats.breakeven, winRate:familyAdjustedStats.winRate, profitFactorR:familyAdjustedStats.profitFactorR, avgResultR:familyAdjustedStats.avgResultR },
    };

    return {
      schema:'alps.v10200.unifiedState.v1', version:this.config.version, generatedAt:iso(), status:overallPass?'LAB_RUNNING':'PARTIAL_OPERATION',
      labRunning:overallPass, researchReady:researchPass, paperLifecycleRunning:paperLifecyclePass,
      execution:{ paperOnly:true, liveCapitalExecution:false, testnetExecution:false },
      adapter:{ ...this.adapter.status(), sourceVersion:text(this.raw.version && this.raw.version.version), sourceProcessInstanceId:text(this.raw.version && this.raw.version.processInstanceId) },
      layers, gates, metrics, candidateAccounting, candidateVisibilityAudit, serverFeatures, familyAdjustedStats,
      learning:{
        status:text(learning.status,'NOT_READY'), generatedAt:learning.generatedAt || null,
        source:learning.source || null, independentExperimentFamilies:finite(learning.independentExperimentFamilies,0),
        rawValidClosedTrades:finite(learning.rawValidClosedTrades,0), correlatedSiblingTradesCollapsed:finite(learning.correlatedSiblingTradesCollapsed,0),
        actions:asArray(learning.learningActions), pairConfidence:asArray(learning.pairConfidence), timeframeConfidence:asArray(learning.timeframeConfidence),
        appliedToCandidatePriority:bool(learning.appliedToCandidatePriority), appliedAsHardFilter:bool(learning.appliedToExecutionAsHardFilter),
      },
      lifecycle:{
        sentinelRuntimeStatus:text(current.sentinelRuntimeStatus,'UNKNOWN'), sentinelLastTickAt:current.sentinelLastTickAt || null,
        sentinelConsecutiveFailures:finite(current.sentinelConsecutiveFailures,0), watchedOpenTrades:finite(current.watchedOpenTrades,0),
        watchedPendingEntries:finite(current.watchedPendingEntries,0), priceSourceSummary:this.priceSourceSummary(current),
        openPositions:finite(live.openPositions,0), closedTrades:finite(live.closedTrades,0), pendingEntries:finite(current.pendingEntries,0),
        lastCheckResult:text(current.lastCheckResult), closeWritebackStatus:text(current.closeWritebackStatus),
      },
      recovery:{ ...this.featureRecovery, missingAgeSec:this.featureRecovery.missingSince ? round((now-timestamp(this.featureRecovery.missingSince))/1000,3) : 0 },
      sourceTruth:{ adapterEndpoint:'/internal/runner/live', sourceVersion:text(live.version), sourceGeneratedAt:live.generatedAt || null, sourceCurrentHealthFresh:bool(live.currentHealthFresh), sourceCurrentHealthAgeSec:finite(live.currentHealthAgeSec,0), serverFeatureAuthority:serverFeatures && serverFeatures.status || 'NOT_AVAILABLE', pollReason:reason },
      lastError:this.lastPollError,
    };
  }

  priceSourceSummary(current) {
    const counts = {};
    for (const row of asArray(current.livePriceFetchProof)) {
      const source = text(row.source,'UNKNOWN'); counts[source]=(counts[source]||0)+1;
    }
    return counts;
  }

  nextAction({ layers, candidateAccounting, familyAdjustedStats }) {
    if (!layers.process.fresh) return 'RECOVER_BROWSER_ENGINE_PROCESS';
    if (!layers.candleBank.fresh) return 'RECOVER_CANONICAL_CANDLE_BANK';
    if (!layers.featureEngine.fresh) return 'RECOVER_FEATURE_EPOCH';
    if (!layers.researchCycle.fresh) return 'RECOVER_RESEARCH_CYCLE';
    if (candidateAccounting.transitions.latchToPaperVisibilityUnresolved > 0) return 'RECONCILE_LATCH_TO_PAPER_VISIBILITY_GAP';
    if (!layers.sentinel.fresh) return 'RECOVER_PRICE_SENTINEL';
    if (familyAdjustedStats.independentFamilies === 0) return 'WAIT_FOR_CURRENT_EPOCH_INDEPENDENT_CLOSES';
    if (!layers.chart.fresh) return 'RECOVER_CHART_TRUTH';
    if (!candidateAccounting.fullAutonomy.active) return 'ACTIVATE_AUTONOMY_ONLY_AFTER_RESEARCH_AND_ACCOUNTING_PASS';
    return 'REVIEW_LAYER_WARNINGS';
  }

  compactLive() {
    const s = this.state;
    return {
      schema:'alps.v10200.liveSummary.v1', version:this.config.version, generatedAt:iso(), status:s.status,
      labRunning:s.labRunning, researchReady:s.researchReady, paperLifecycleRunning:s.paperLifecycleRunning,
      execution:s.execution, layers:s.layers, gates:s.gates, metrics:s.metrics,
      candidateAccounting:{ status:s.candidateAccounting && s.candidateAccounting.status, transitions:s.candidateAccounting && s.candidateAccounting.transitions, fullAutonomy:s.candidateAccounting && s.candidateAccounting.fullAutonomy },
      featureAuthority:s.serverFeatures ? { status:s.serverFeatures.status, ready:s.serverFeatures.ready, featureRowsFound:s.serverFeatures.featureRowsFound, freshFeaturePairFrames:s.serverFeatures.freshFeaturePairFrames, requiredPairFrames:s.serverFeatures.requiredPairFrames, lastRefreshCompletedAt:s.serverFeatures.lastRefreshCompletedAt } : null,
      learning:{ status:s.learning && s.learning.status, independentExperimentFamilies:s.learning && s.learning.independentExperimentFamilies, actions:s.learning && s.learning.actions },
      lifecycle:s.lifecycle, recovery:s.recovery, adapter:s.adapter, sourceTruth:s.sourceTruth,
      endpoints:{ features:'/runner/features', candidates:'/runner/candidates', lifecycle:'/runner/lifecycle', learning:'/runner/learning', ledgerStats:'/runner/ledger-stats', selfTest:'/runner/self-test' },
      rule:'LAB_RUNNING requires independent freshness and readiness of research, candidate accounting, paper lifecycle, learning, and chart layers. A fresh sentinel cannot hide a stalled research engine.',
    };
  }

  selfTest() {
    const s = this.state;
    const distinct = s.layers && s.layers.sentinel && s.layers.featureEngine && s.layers.sentinel.evidenceField !== s.layers.featureEngine.evidenceField;
    const noFalsePass = !(s.gates && s.gates.overall && s.gates.overall.pass) || (s.researchReady && s.paperLifecycleRunning && s.gates.candidateAccounting.pass && s.gates.chart.pass);
    const compactBytes = Buffer.byteLength(JSON.stringify(this.compactLive()));
    return {
      schema:'alps.v10200.selfTest.v1', version:this.config.version, generatedAt:iso(),
      browserEngineIsolated:this.adapter.status().mode==='ISOLATED_LEGACY_BROWSER_ENGINE_ADAPTER',
      independentLayerFreshness:Boolean(distinct),
      sentinelCannotMaskFeatureFailure:Boolean(s.layers && (!s.layers.sentinel.fresh || s.layers.featureEngine.fresh || !s.researchReady)),
      overallPassCannotIgnoreResearch:Boolean(noFalsePass),
      candidateAccountingPublished:Boolean(s.candidateAccounting && s.candidateAccounting.transitions),
      serverFeatureAuthorityPublished:Boolean(s.serverFeatures && s.serverFeatures.schema),
      familyAdjustedPerformancePublished:Boolean(s.familyAdjustedStats && typeof s.familyAdjustedStats.independentFamilies==='number'),
      liveSummaryCompact:compactBytes <= this.config.liveSummaryMaxBytes,
      liveSummaryBytes:compactBytes,
      paperOnly:s.execution && s.execution.paperOnly===true,
      liveCapitalExecution:s.execution && s.execution.liveCapitalExecution===true,
      testnetExecution:s.execution && s.execution.testnetExecution===true,
      pass:Boolean(distinct && noFalsePass && s.candidateAccounting && s.familyAdjustedStats && s.serverFeatures && compactBytes <= this.config.liveSummaryMaxBytes && s.execution && s.execution.paperOnly && !s.execution.liveCapitalExecution && !s.execution.testnetExecution),
    };
  }

  async forceResearchRecovery() {
    this.featureRecovery.lastActionAt = null;
    this.featureRecovery.actionCount = 0;
    await this.maybeRecoverFeatures(this.raw.live, 'manual-force-recovery');
    return this.poll('after-manual-force-recovery');
  }
}

module.exports = { UnifiedOrchestrator };
