'use strict';

const { URL } = require('url');
const {
  loadConfig,
  PersistenceQueue,
  MultiMarketEngine,
  MultiMarketServer,
} = require('./v1202-bundle');
const {
  PolicyShadowEngine,
  SERVICE_VERSION,
  SHADOW_VERSION,
  CONTROL_VERSION,
  INTEGRITY_PATCH_VERSION,
  TAXONOMY_HASH,
  CLASSIFICATION_ALGORITHM_VERSION,
} = require('./policy-shadow-integrity-v12073');

function iso(value = Date.now()) { return new Date(value).toISOString(); }
function bytes(value) { return Buffer.byteLength(JSON.stringify(value)); }
function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type':'application/json; charset=utf-8',
    'content-length':Buffer.byteLength(text),
    'cache-control':'no-store',
    'access-control-allow-origin':'*',
    'x-content-type-options':'nosniff',
    'x-alps-payload-bytes':String(Buffer.byteLength(text)),
  });
  res.end(text);
}
function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > maxBytes) reject(new Error('REQUEST_BODY_TOO_LARGE'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { reject(new Error('INVALID_JSON')); }
    });
    req.on('error', reject);
  });
}

function compactPersistence(value) {
  if (!value || typeof value !== 'object') return value || null;
  return {
    revision:value.revision ?? null,
    committedRevision:value.committedRevision ?? null,
    pendingRevision:value.pendingRevision ?? null,
    pendingDurable:value.pendingDurable ?? false,
    writing:value.writing === true,
    activeWriteCount:value.activeWriteCount ?? null,
    queueDepth:value.queueDepth ?? null,
    lastError:value.lastError || null,
    lastCommittedAt:value.lastCommittedAt || null,
    writesStarted:value.writesStarted ?? null,
    writesCommitted:value.writesCommitted ?? null,
    writesFailed:value.writesFailed ?? null,
    retries:value.retries ?? null,
  };
}

function compactForwardShadow(value) {
  if (!value || typeof value !== 'object') return value || null;
  const candidates = value.candidates || {};
  const performance = candidates.performance || value.performance || {};
  return {
    schema:value.schema || null,
    version:value.version || null,
    epochAt:value.epochAt || null,
    foundationEpochAt:value.foundationEpochAt || null,
    candidateEngineEpochAt:value.candidateEngineEpochAt || candidates.candidateEngineEpochAt || null,
    evidenceClass:value.evidenceClass || candidates.evidenceClass || null,
    mode:value.mode || candidates.mode || null,
    status:value.status || candidates.status || null,
    candidateEngineEnabled:value.candidateEngineEnabled ?? candidates.candidateEngineEnabled ?? null,
    paperExecutionEnabled:value.paperExecutionEnabled ?? candidates.paperExecutionEnabled ?? null,
    executionEnabled:false,
    promotionEnabled:false,
    liveCapitalExecution:false,
    observedClosedCandles:value.observedClosedCandles ?? null,
    framesWithPostDeployObservation:value.framesWithPostDeployObservation ?? null,
    continuityPassedFrames:value.continuityPassedFrames ?? null,
    cleanFrames:value.cleanFrames ?? null,
    forwardShadowEligible:value.forwardShadowEligible ?? null,
    temporalIntegrity:value.temporalIntegrity || candidates.temporalIntegrity || null,
    lastEvaluatedAt:value.lastEvaluatedAt || candidates.lastEvaluatedAt || null,
    lastLedgerEventAt:candidates.lastLedgerEventAt || null,
    pendingCandidateCount:candidates.pendingCandidateCount ?? null,
    openCandidateCount:candidates.openCandidateCount ?? null,
    performance:{
      totalCandidates:performance.totalCandidates ?? null,
      totalOpened:performance.totalOpened ?? null,
      activeCandidates:performance.activeCandidates ?? null,
      closedCandidates:performance.closedCandidates ?? null,
      totalLegs:performance.totalLegs ?? null,
      openLegs:performance.openLegs ?? null,
      targetHits:performance.targetHits ?? null,
      stopHits:performance.stopHits ?? null,
      ambiguousLegs:performance.ambiguousLegs ?? null,
      scoredLegs:performance.scoredLegs ?? null,
      wins:performance.wins ?? null,
      losses:performance.losses ?? null,
      breakeven:performance.breakeven ?? null,
      netR:performance.netR ?? null,
      byRiskReward:performance.byRiskReward || null,
      totalNominations:performance.totalNominations ?? null,
      pendingEntries:performance.pendingEntries ?? null,
      entryExpired:performance.entryExpired ?? null,
      certifiedForwardOnly:performance.certifiedForwardOnly ?? null,
      winRate:performance.winRate ?? null,
    },
    cycle:candidates.cycle ? {
      reason:candidates.cycle.reason || null,
      startedAt:candidates.cycle.startedAt || null,
      completedAt:candidates.cycle.completedAt || null,
      framesEvaluated:candidates.cycle.framesEvaluated ?? null,
      hypothesesEvaluated:candidates.cycle.hypothesesEvaluated ?? null,
      candidatesProduced:candidates.cycle.candidatesProduced ?? null,
      nominationsProduced:candidates.cycle.nominationsProduced ?? null,
      entriesOpened:candidates.cycle.entriesOpened ?? null,
      entryExpired:candidates.cycle.entryExpired ?? null,
      duplicatesBlocked:candidates.cycle.duplicatesBlocked ?? null,
      lifecycleEvents:candidates.cycle.lifecycleEvents ?? null,
      temporalViolations:candidates.cycle.temporalViolations ?? null,
    } : null,
    riskPolicy:candidates.riskPolicy || null,
    setupPolicy:candidates.setupPolicy || null,
    provisionalV1205Ledger:value.provisionalV1205Ledger ? {
      classification:value.provisionalV1205Ledger.classification || null,
      preserved:value.provisionalV1205Ledger.preserved === true,
      deleted:value.provisionalV1205Ledger.deleted === true,
      countedInCertifiedPerformance:value.provisionalV1205Ledger.countedInCertifiedPerformance === true,
      totalCandidates:value.provisionalV1205Ledger.totalCandidates ?? null,
      activeCandidates:value.provisionalV1205Ledger.activeCandidates ?? null,
      closedCandidates:value.provisionalV1205Ledger.closedCandidates ?? null,
      scoredLegs:value.provisionalV1205Ledger.scoredLegs ?? null,
      netR:value.provisionalV1205Ledger.netR ?? null,
      ledgerBytes:value.provisionalV1205Ledger.ledgerBytes ?? null,
    } : null,
    lastError:candidates.lastError || value.lastError || null,
  };
}

function compactEvidenceScoring(value) {
  if (!value || typeof value !== 'object') return value || null;
  const diagnostics = value.diagnostics || {};
  return {
    schema:value.schema || null,
    version:value.version || null,
    status:value.status || null,
    enabled:value.enabled === true,
    mode:value.mode || null,
    sourceEvidenceClass:value.sourceEvidenceClass || null,
    certifiedOnly:value.certifiedOnly === true,
    provisionalExcluded:value.provisionalExcluded === true,
    paperOnly:true,
    liveCapitalExecution:false,
    executionEnabled:false,
    promotionEnabled:false,
    rankingEnabled:false,
    candidateEngineMutation:false,
    v11Writes:0,
    thresholds:value.thresholds || null,
    lastSnapshotId:value.lastSnapshotId || null,
    lastSnapshotAt:value.lastSnapshotAt || null,
    lastInputFingerprint:value.lastInputFingerprint || null,
    hypothesesScored:value.hypothesesScored ?? null,
    clustersObserved:value.clustersObserved ?? null,
    independentEvaluatedClustersByLeg:value.independentEvaluatedClustersByLeg || null,
    byState:value.byState || null,
    diagnosticsSummary:{
      entryModelStarvedCount:Array.isArray(diagnostics.entryModelStarved) ? diagnostics.entryModelStarved.length : 0,
      clusterMemberDivergenceCount:Array.isArray(diagnostics.clusterMemberDivergence) ? diagnostics.clusterMemberDivergence.length : 0,
      conflictFrameCount:Array.isArray(diagnostics.conflictBySymbolTimeframe) ? diagnostics.conflictBySymbolTimeframe.length : 0,
      ambiguityFrameLegCount:Array.isArray(diagnostics.ambiguityBySymbolTimeframeLeg) ? diagnostics.ambiguityBySymbolTimeframeLeg.length : 0,
    },
  };
}

function compactForexScheduler(value) {
  if (!value || typeof value !== 'object') return value || null;
  return {
    leaseActive:value.leaseActive === true,
    leaseId:value.leaseId || null,
    leaseAcquiredAt:value.leaseAcquiredAt || null,
    leaseExpiresAt:value.leaseExpiresAt || null,
    leaseAgeMs:value.leaseAgeMs ?? null,
    leaseExpired:value.leaseExpired === true,
    leaseDurationMs:value.leaseDurationMs ?? null,
    leaseRecovered:value.leaseRecovered === true,
    leaseRecoveryReason:value.leaseRecoveryReason || null,
    currentPair:value.currentPair || null,
    currentOperation:value.currentOperation || null,
    schedulerRunning:value.schedulerRunning === true,
    schedulerHeartbeatAt:value.schedulerHeartbeatAt || null,
    watchdogHeartbeatAt:value.watchdogHeartbeatAt || null,
    nextScheduledAt:value.nextScheduledAt || null,
    lastCycleStartedAt:value.lastCycleStartedAt || null,
    lastSuccessfulCycleAt:value.lastSuccessfulCycleAt || null,
    lastCycleCompletedAt:value.lastCycleCompletedAt || null,
    cycleInFlight:value.cycleInFlight === true,
    cycleAgeMs:value.cycleAgeMs ?? null,
    cycleHardLimitMs:value.cycleHardLimitMs ?? null,
    consecutiveFailures:value.consecutiveFailures ?? null,
    lastFailureAt:value.lastFailureAt || null,
    lastFailureCode:value.lastFailureCode || null,
    liveRefreshAttemptedPairs:value.liveRefreshAttemptedPairs ?? null,
    liveRefreshCompletedPairs:value.liveRefreshCompletedPairs ?? null,
    liveRefreshFailedPairs:value.liveRefreshFailedPairs ?? null,
    liveRefreshSkippedPairs:value.liveRefreshSkippedPairs ?? null,
    backfillCreditsUsedToday:value.backfillCreditsUsedToday ?? null,
    backfillPairsProcessed:value.backfillPairsProcessed ?? null,
    backfillDay:value.backfillDay || null,
    watchdogRecoveries:value.watchdogRecoveries ?? null,
    abandonedCycles:value.abandonedCycles ?? null,
    persistErrors:value.persistErrors || null,
    circuitBreakerPersistencePending:value.circuitBreakerPersistencePending === true,
    persistence:value.persistence ? {
      forexState:compactPersistence(value.persistence.forexState),
      budget:compactPersistence(value.persistence.budget),
      lease:compactPersistence(value.persistence.lease),
    } : null,
    memory:value.memory || null,
  };
}

function compactLease(value) {
  if (!value || typeof value !== 'object') return value || null;
  return {
    schema:value.schema || null,
    leaseActive:value.leaseActive === true,
    leaseId:value.leaseId || null,
    leaseAcquiredAt:value.leaseAcquiredAt || null,
    leaseExpiresAt:value.leaseExpiresAt || null,
    leaseAgeMs:value.leaseAgeMs ?? null,
    leaseDurationMs:value.leaseDurationMs ?? null,
    leaseExpired:value.leaseExpired === true,
    leaseOwner:value.leaseOwner || null,
    leasePurpose:value.leasePurpose || null,
    currentPair:value.currentPair || null,
    currentOperation:value.currentOperation || null,
    leaseRecovered:value.leaseRecovered === true,
    leaseRecoveryReason:value.leaseRecoveryReason || null,
    acquisitions:value.acquisitions ?? null,
    releases:value.releases ?? null,
    recoveries:value.recoveries ?? null,
    lastReleasedAt:value.lastReleasedAt || null,
    lastReleaseReason:value.lastReleaseReason || null,
    lastPersistError:value.lastPersistError || null,
    persistence:compactPersistence(value.persistence),
  };
}

function compactProvider(value) {
  if (!value || typeof value !== 'object') return value || null;
  return {
    schema:value.schema || null,
    blockedUntil:value.blockedUntil || null,
    last429At:value.last429At || null,
    last418At:value.last418At || null,
    lastRequestAt:value.lastRequestAt || null,
    requestCount:value.requestCount ?? null,
    lastHttpStatus:value.lastHttpStatus ?? null,
    lastError:value.lastError || null,
    usedWeight1m:value.usedWeight1m ?? null,
    status:value.status || null,
    blocked:value.blocked === true,
    baseUrl:value.baseUrl || null,
    publicMarketDataOnly:value.publicMarketDataOnly === true,
    apiKeyRequired:value.apiKeyRequired === true,
    allowedEndpoint:value.allowedEndpoint || null,
    requestPolicy:value.requestPolicy || null,
    maximumScheduledCallsPerCycle:value.maximumScheduledCallsPerCycle ?? null,
  };
}

class PolicyShadowServer extends MultiMarketServer {
  constructor({ config, engine, policyShadow, log = console.log }) {
    super({ config, engine, log });
    this.policyShadow = policyShadow;
  }
  versionView() {
    const view = this.engine.view();
    const body = {
      schema:'alps.runner.version.v12073',
      version:SERVICE_VERSION,
      candidateEngineVersion:CONTROL_VERSION,
      shadowPolicyEngineVersion:SHADOW_VERSION,
      integrityPatchVersion:INTEGRITY_PATCH_VERSION,
      taxonomyHash:TAXONOMY_HASH,
      classificationAlgorithmVersion:CLASSIFICATION_ALGORITHM_VERSION,
      status:view.status,
      generatedAt:view.generatedAt,
      gen2Enabled:true,
      gen2WorkerOnline:view.gen2WorkerOnline,
      legacyEngineEnabled:false,
      paperOnly:true,
      executionEnabled:false,
      liveCapitalExecution:false,
      promotionEnabled:false,
      dataMode:'MULTI_MARKET_PRICE_ONLY',
      forexCoreEnabled:this.config.forexEnabled,
      cryptoCoreEnabled:this.config.cryptoEnabled,
      newsLayer:'REMOVED',
      ukOilEnabled:false,
      dashboard:{ installed:true, url:'/', refreshSeconds:15, mode:'LIVE_NO_CACHE', tabs:['overview','crypto','forex','research','problems'] },
      readiness:view.readiness,
      cryptoContinuity:view.crypto && view.crypto.continuity || null,
      cryptoForwardShadow:compactForwardShadow(view.crypto && view.crypto.forwardShadow),
      forexBudget:view.forex && view.forex.budget ? {
        schema:view.forex.budget.schema || null,
        day:view.forex.budget.day || null,
        usedCredits:view.forex.budget.usedCredits ?? null,
        hardLimit:view.forex.budget.hardLimit ?? null,
        scheduledCeiling:view.forex.budget.scheduledCeiling ?? null,
        remainingHard:view.forex.budget.remainingHard ?? null,
        remainingScheduled:view.forex.budget.remainingScheduled ?? null,
        blocked:view.forex.budget.blocked === true,
        blockedUntil:view.forex.budget.blockedUntil || null,
        first429At:view.forex.budget.first429At || null,
        last429At:view.forex.budget.last429At || null,
        status:view.forex.budget.status || null,
        lastRequestAt:view.forex.budget.lastRequestAt || null,
        requestCount:view.forex.budget.requestCount ?? null,
        lastPersistError:view.forex.budget.lastPersistError || null,
        persistence:compactPersistence(view.forex.budget.persistence),
      } : null,
      forexScheduler:compactForexScheduler(view.forex && view.forex.scheduler),
      forexLease:compactLease(view.forex && view.forex.lease),
      cryptoProvider:compactProvider(view.crypto && view.crypto.provider),
      evidenceScoring:compactEvidenceScoring(view.crypto && view.crypto.evidenceScoring),
      policyShadow:this.policyShadow.view(),
      memory:view.memory || view.forex && view.forex.scheduler && view.forex.scheduler.memory || null,
      reporting:{
        versionPayloadBytes:null,
        versionPayloadTargetBytes:200 * 1024,
        versionPayloadWarningBytes:250 * 1024,
      },
    };
    body.reporting.versionPayloadBytes = bytes(body);
    body.reporting.versionPayloadWithinTarget = body.reporting.versionPayloadBytes <= body.reporting.versionPayloadTargetBytes;
    body.reporting.versionPayloadWarning = body.reporting.versionPayloadBytes > body.reporting.versionPayloadWarningBytes;
    return body;
  }
  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && ['/health','/runner/version'].includes(url.pathname)) {
      return sendJson(res, 200, this.versionView());
    }
    if (req.method === 'GET' && url.pathname === '/runner/policy-shadow') {
      return sendJson(res, 200, this.policyShadow.view());
    }
    if (req.method === 'GET' && url.pathname === '/runner/policy-shadow/arms') {
      return sendJson(res, 200, this.policyShadow.armsView(url.searchParams));
    }
    if (req.method === 'GET' && url.pathname === '/runner/policy-shadow/comparisons') {
      return sendJson(res, 200, this.policyShadow.comparisonsView(url.searchParams));
    }
    if (req.method === 'GET' && url.pathname === '/runner/policy-shadow/diagnostics') {
      return sendJson(res, 200, this.policyShadow.diagnosticsView());
    }
    if (req.method === 'GET' && url.pathname === '/runner/policy-shadow/snapshots') {
      return sendJson(res, 200, {
        schema:'alps.gen2.policyShadowSnapshotsTail.v12073',
        version:SERVICE_VERSION,
        generatedAt:iso(),
        snapshots:await this.policyShadow.snapshotsTail(url.searchParams.get('limit') || 50),
      });
    }
    if (req.method === 'GET' && url.pathname === '/runner/policy-shadow/manifest') {
      return sendJson(res, 200, this.policyShadow.manifestView());
    }
    if (req.method === 'POST' && url.pathname === '/runner/command') {
      if (!this.authorized(req)) return sendJson(res, 403, { status:'FORBIDDEN' });
      try {
        const body = await readBody(req);
        const command = String(body.command || '').trim().toLowerCase();
        if (command === 'refresh-all') {
          return sendJson(res, 200, {
            forex:await this.engine.forex.refreshAll('private-command'),
            crypto:await this.engine.crypto.refreshAll('private-command'),
          });
        }
        if (command === 'refresh-forex') return sendJson(res, 200, await this.engine.forex.refreshAll('private-command'));
        if (command === 'refresh-crypto') return sendJson(res, 200, await this.engine.crypto.refreshAll('private-command'));
        if (command === 'clean-rebuild') {
          return sendJson(res, 200, {
            forex:await this.engine.forex.cleanAndRebuild('private-command'),
            crypto:await this.engine.crypto.cleanAndRebuild('private-command'),
          });
        }
        if (command === 'backfill') {
          return sendJson(res, 200, {
            forex:await this.engine.forex.backfillIncomplete('private-command'),
            crypto:await this.engine.crypto.backfillIncomplete('private-command'),
          });
        }
        if (command === 'score-evidence') return sendJson(res, 200, await this.engine.crypto.evidenceScorer.run('private-command'));
        if (command === 'run-policy-shadow') return sendJson(res, 200, await this.policyShadow.run('private-command'));
        return sendJson(res, 400, {
          status:'UNKNOWN_COMMAND',
          allowed:['refresh-all','refresh-forex','refresh-crypto','clean-rebuild','backfill','score-evidence','run-policy-shadow'],
        });
      } catch (error) {
        return sendJson(res, 400, { status:'COMMAND_FAILED', error:String(error.message || error) });
      }
    }
    return super.handle(req, res);
  }
}

function installViews(engine, policyShadow) {
  const originalCryptoView = engine.crypto.view.bind(engine.crypto);
  engine.crypto.view = () => ({ ...originalCryptoView(), policyShadow:policyShadow.view() });
  const originalEngineView = engine.view.bind(engine);
  engine.view = () => ({ ...originalEngineView(), version:SERVICE_VERSION, policyShadow:policyShadow.view() });
}

function installCandidateCycleHook(engine, policyShadow, log) {
  const original = engine.crypto.cleanAndRebuild.bind(engine.crypto);
  engine.crypto.cleanAndRebuild = async (...args) => {
    const result = await original(...args);
    policyShadow.schedule(`candidate-cycle-complete:${String(args[0] || 'unknown')}`);
    return result;
  };
  log('[v12.0.7.3] policy-shadow hook installed after certified candidate cycles');
}

async function main() {
  const config = loadConfig();
  const startupAt = iso();
  const log = (...args) => console.log(new Date().toISOString(), ...args);
  log(`[v12.0.7.3] starting ${SERVICE_VERSION}`);
  log(`[v12.0.7.3] certified control=${CONTROL_VERSION} shadow=${SHADOW_VERSION} integrity=${INTEGRITY_PATCH_VERSION}`);
  log(`[v12.0.7.3] taxonomy=${TAXONOMY_HASH} classifier=${CLASSIFICATION_ALGORITHM_VERSION}`);
  log('[v12.0.7.3] mode=PRE_REGISTERED_POLICY_SHADOW paperOnly=true execution=false promotion=false');
  log(`[v12.0.7.3] roots v12=${config.dataRoot} v11=${config.legacyRoot} (read-only)`);

  const engine = new MultiMarketEngine({ config, log });
  const policyQueue = new PersistenceQueue({ storage:engine.storage, log });
  const policyShadow = new PolicyShadowEngine({
    config,
    storage:engine.storage,
    persistQueue:policyQueue,
    log,
    startupAt,
    controlViewProvider:() => engine.crypto.candidateEngine.view(),
    scoringViewProvider:() => engine.crypto.evidenceScorer.view(),
  });
  installViews(engine, policyShadow);
  const server = new PolicyShadowServer({ config, engine, policyShadow, log });

  let stopping = false;
  const shutdown = async signal => {
    if (stopping) return;
    stopping = true;
    log(`[v12.0.7.3] shutdown ${signal}`);
    await policyShadow.stop().catch(error => log('policy shadow stop failed', error));
    await engine.stop().catch(error => log('engine stop failed', error));
    await server.stop().catch(error => log('server stop failed', error));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('uncaughtException', error => {
    log('uncaughtException', error.stack || error);
    process.exitCode = 1;
    shutdown('uncaughtException');
  });
  process.once('unhandledRejection', error => {
    log('unhandledRejection', error && error.stack || error);
    process.exitCode = 1;
    shutdown('unhandledRejection');
  });

  await server.start();
  engine.status = 'CONTROL_PLANE_READY_INITIALIZING';
  log('[v12.0.7.3] control plane ready; certified workers initialize without mutation');
  (async () => {
    try {
      await engine.init();
      await policyShadow.init();
      installCandidateCycleHook(engine, policyShadow, log);
      policyShadow.startFallback();
      await policyShadow.run('startup-post-manifest-catchup');
      if (!stopping) log(`[v12.0.7.3] workers online status=${engine.statusValue()} policy=${policyShadow.view().status}`);
    } catch (error) {
      engine.status = 'DEGRADED_INITIALIZATION_FAILED';
      engine.lastError = String(error.stack || error).slice(0, 2400);
      log('[v12.0.7.3] initialization failed', error.stack || error);
    }
  })();
  return { config, engine, policyShadow, server };
}

module.exports = {
  main,
  PolicyShadowServer,
  installViews,
  installCandidateCycleHook,
  compactForwardShadow,
  compactEvidenceScoring,
  compactForexScheduler,
  compactProvider,
};
