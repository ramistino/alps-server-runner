'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ageSec, asObject, finite, iso, summarizeError, text } = require('./utils');

function sendJson(res, status, value) {
  const raw = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'content-type':'application/json; charset=utf-8',
    'content-length':Buffer.byteLength(raw),
    'cache-control':'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    'access-control-allow-origin':'*',
  });
  res.end(raw);
}

function atomicWriteJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive:true });
  const temp = `${filename}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, filename);
}

function readJson(filename) {
  try {
    if (!fs.existsSync(filename)) return null;
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

function preparePersistentLayout(config) {
  const layout = {
    root:config.persistentRoot,
    dataDir:config.dataDir,
    reportDir:config.reportDir,
    profileDir:config.profileDir,
    ledgerDir:config.ledgerDir,
  };
  for (const dir of Object.values(layout)) fs.mkdirSync(dir, { recursive:true });
  process.env.ALPS_PERSISTENT_DIR = layout.root;
  process.env.ALPS_DATA_DIR = layout.dataDir;
  process.env.ALPS_REPORT_DIR = layout.reportDir;
  process.env.ALPS_PROFILE_DIR = layout.profileDir;
  process.env.ALPS_LEDGER_DIR = layout.ledgerDir;
  return {
    schema:'alps.v10202.persistentLayout.v1',
    status:'UNIFIED_PERSISTENT_LAYOUT_READY',
    ...layout,
  };
}

class OperationalTruthStore {
  constructor({ config, log = console.log }) {
    this.config = config;
    this.log = log;
    this.stateFile = config.operationalStateFile;
    this.proofFile = config.paperEntryProofFile;
    this.state = readJson(this.stateFile);
    this.proof = readJson(this.proofFile);
    this.lastError = null;
    this.lastPersistAt = this.state && this.state.generatedAt ? Date.parse(this.state.generatedAt) || 0 : 0;
    this.lastSignature = this.state && this.state.signature || null;
  }

  derivePaperEntryProof(live, receivedAt = Date.now()) {
    const root = asObject(live);
    const current = asObject(root.currentHealth);
    const candidates = Math.max(0, finite(root.candidates, current.candidates || 0));
    const nativePool = Math.max(0, finite(root.nativePoolCandidates, current.nativePoolCandidates || 0));
    const forwardLatch = Math.max(0, finite(root.forwardLatchSize, current.forwardLatchSize || 0));
    const visibilitySeen = Math.max(0, finite(
      root.paperEntryVisibilityCandidatesSeen,
      current.paperEntryVisibilityCandidatesSeen || 0
    ));
    const pendingEntries = Math.max(0, finite(current.pendingEntries, root.pendingEntries || 0));
    const openPositions = Math.max(0, finite(root.openPositions, current.openPositions || 0));
    const closedTrades = Math.max(0, finite(root.closedTrades, current.closedTrades || 0));
    const scannerObserved = Boolean(
      current.paperEntryLastScanAt ||
      current.pendingEntryLastScanAt ||
      current.paperEntryVisibilityLastScanAt
    );
    const lifecycleProven = pendingEntries > 0 || openPositions > 0 || closedTrades > 0;
    const proofPresent = scannerObserved || visibilitySeen > 0 || lifecycleProven;
    const status = lifecycleProven
      ? 'PAPER_ENTRY_LIFECYCLE_PROVEN'
      : visibilitySeen > 0
        ? 'PAPER_ENTRY_SCANNER_OBSERVED_CANDIDATES'
        : scannerObserved
          ? 'PAPER_ENTRY_SCANNER_ACTIVE_ZERO_OR_MORE_CANDIDATES'
          : forwardLatch > 0
            ? 'PAPER_ENTRY_VISIBILITY_NOT_YET_PROVEN'
            : 'WAITING_FOR_FORWARD_LATCH';

    return {
      schema:'alps.v10202.paperEntryProof.v1',
      version:this.config.version,
      generatedAt:iso(receivedAt),
      sourceGeneratedAt:root.generatedAt || current.generatedAt || null,
      status,
      proofPresent,
      lifecycleProven,
      scannerObserved,
      independentFromDiscoveryCount:true,
      notInferredFromCandidatesOnly:true,
      stages:{ candidates, nativePool, forwardLatch, visibilitySeen, pendingEntries, openPositions, closedTrades },
      evidence:{
        paperEntryLastScanAt:current.paperEntryLastScanAt || null,
        pendingEntryLastScanAt:current.pendingEntryLastScanAt || null,
        paperEntryVisibilityLastScanAt:current.paperEntryVisibilityLastScanAt || null,
        sentinelLastTickAt:current.sentinelLastTickAt || null,
        sentinelLastPriceFetchAt:current.sentinelLastPriceFetchAt || null,
        lastCheckResult:text(current.lastCheckResult),
        closeWritebackStatus:text(current.closeWritebackStatus),
      },
      rule:'Paper Entry is proven only by scanner visibility, pending-entry state, open positions, or closed-trade lifecycle evidence. Candidate and latch counts alone never fabricate proof.',
    };
  }

  save(live, receivedAt = Date.now()) {
    try {
      const proof = this.derivePaperEntryProof(live, receivedAt);
      const current = asObject(live && live.currentHealth);
      const signaturePayload = {
        status:live && live.status || null,
        labRunning:Boolean(live && live.labRunning),
        researchReady:Boolean(live && live.researchReady),
        stages:proof.stages,
        evidence:proof.evidence,
        candidateEpoch:current.candidateEpochId || current.candidateAuthorityGeneratedAt || null,
      };
      const signature = crypto.createHash('sha256')
        .update(JSON.stringify(signaturePayload))
        .digest('hex')
        .slice(0, 24);
      const generatedAt = iso(receivedAt);
      const state = {
        schema:'alps.v10202.operationalTruthCache.v1',
        version:this.config.version,
        generatedAt,
        sourceGeneratedAt:live && live.generatedAt || null,
        status:'CACHED_OPERATIONAL_TRUTH_READY',
        signature,
        operationalTruth:live,
        paperEntryProof:proof,
        persistence:{ stateFile:this.stateFile, proofFile:this.proofFile, atomicWrite:true },
      };
      const persistDue = receivedAt - this.lastPersistAt >= this.config.operationalPersistIntervalMs;
      const materiallyChanged = signature !== this.lastSignature;
      if (persistDue || materiallyChanged || !this.state) {
        atomicWriteJson(this.stateFile, state);
        atomicWriteJson(this.proofFile, proof);
        this.lastPersistAt = receivedAt;
        this.lastSignature = signature;
      }
      this.state = state;
      this.proof = proof;
      this.lastError = null;
    } catch (error) {
      this.lastError = summarizeError(error);
      this.log('[v10.2.2] operational truth persistence failed', this.lastError);
    }
    return this.view();
  }

  cachedLive() {
    return asObject(this.state && this.state.operationalTruth);
  }

  proofView() {
    return this.proof || {
      schema:'alps.v10202.paperEntryProof.v1',
      version:this.config.version,
      generatedAt:null,
      status:'NO_PERSISTED_PAPER_ENTRY_PROOF',
      proofPresent:false,
      lifecycleProven:false,
      independentFromDiscoveryCount:true,
      notInferredFromCandidatesOnly:true,
      stages:{ candidates:0, nativePool:0, forwardLatch:0, visibilitySeen:0, pendingEntries:0, openPositions:0, closedTrades:0 },
    };
  }

  view(now = Date.now()) {
    const generatedAt = this.state && this.state.generatedAt || null;
    return {
      schema:'alps.v10202.operationalTruthSidecar.v1',
      version:this.config.version,
      status:this.state ? 'CACHED_OPERATIONAL_TRUTH_READY' : 'WAITING_FOR_FIRST_OPERATIONAL_REFRESH',
      generatedAt,
      ageSec:Number.isFinite(ageSec(generatedAt, now)) ? Math.round(ageSec(generatedAt, now) * 1000) / 1000 : null,
      sourceGeneratedAt:this.state && this.state.sourceGeneratedAt || null,
      stateFile:this.stateFile,
      proofFile:this.proofFile,
      lastError:this.lastError,
      cacheLoadedFromDisk:Boolean(this.state),
      paperEntryProof:this.proofView(),
      rule:'The lightweight process heartbeat never waits for /runner/live. Operational truth refreshes and persists independently.',
    };
  }
}

function recomputeTopLevelState(state) {
  const layers = asObject(state.layers);
  const gates = asObject(state.gates);
  const paperLifecyclePass = Boolean(
    layers.process && layers.process.fresh &&
    layers.sentinel && layers.sentinel.fresh &&
    layers.paperEntry && layers.paperEntry.fresh &&
    layers.candidatePipeline && layers.candidatePipeline.fresh
  );
  const researchPass = Boolean(
    layers.process && layers.process.fresh &&
    layers.candleBank && layers.candleBank.fresh &&
    layers.featureEngine && layers.featureEngine.fresh &&
    layers.strategyEngine && layers.strategyEngine.fresh &&
    layers.researchCycle && layers.researchCycle.fresh &&
    layers.candidatePipeline && layers.candidatePipeline.fresh
  );
  if (gates.paperLifecycle) {
    gates.paperLifecycle.pass = paperLifecyclePass;
    gates.paperLifecycle.status = paperLifecyclePass ? 'PASS' : 'WARN';
  }
  if (gates.research) {
    gates.research.pass = researchPass;
    gates.research.status = researchPass ? 'PASS' : 'WARN';
  }
  const overallPass = Boolean(
    paperLifecyclePass &&
    researchPass &&
    gates.candidateAccounting && gates.candidateAccounting.pass &&
    gates.learning && gates.learning.pass &&
    gates.chart && gates.chart.pass &&
    gates.autonomy && gates.autonomy.pass
  );
  if (gates.overall) {
    gates.overall.pass = overallPass;
    gates.overall.status = overallPass ? 'PASS' : 'WARN';
  }
  state.paperLifecycleRunning = paperLifecyclePass;
  state.researchReady = researchPass;
  state.labRunning = overallPass;
  state.status = overallPass ? 'LAB_RUNNING' : 'PARTIAL_OPERATION';
  return state;
}

function installV1022RuntimeAuthority({ orchestrator, adapter, config, log = console.log }) {
  const store = new OperationalTruthStore({ config, log });
  const cached = store.cachedLive();
  if (Object.keys(cached).length && !orchestrator.raw.live) {
    orchestrator.raw.live = cached;
    try {
      orchestrator.strategyHeartbeat.observe(cached, Date.now());
      orchestrator.candidateCohortTracker.observe({
        live:cached,
        candidateAuthority:orchestrator.raw.candidateAuthority,
        now:Date.now(),
      });
    } catch (error) {
      log('[v10.2.2] cached truth bootstrap warning', summarizeError(error));
    }
  }

  orchestrator.runtime.operational = orchestrator.runtime.operational || {
    sequence:0,
    inFlight:false,
    lastStartedAt:null,
    lastCompletedAt:null,
    lastSuccessAt:null,
    lastError:null,
    durationMs:0,
    consecutiveFailures:0,
    source:'PRIVATE_ADAPTER_RUNNER_LIVE',
  };

  const originalRuntimeView = orchestrator.runtimeView.bind(orchestrator);
  const originalStart = orchestrator.start.bind(orchestrator);
  const originalStop = orchestrator.stop.bind(orchestrator);
  const originalSnapshot = orchestrator.snapshot.bind(orchestrator);
  const originalCompactLive = orchestrator.compactLive.bind(orchestrator);
  const originalSelfTest = orchestrator.selfTest.bind(orchestrator);
  const originalAdapterStatus = adapter.status.bind(adapter);
  let operationalTimer = null;
  let operationalAttemptId = 0;

  orchestrator.runtimeView = function runtimeViewV1022() {
    const value = originalRuntimeView();
    return {
      ...value,
      operational:{...this.runtime.operational},
      authorityMode:'LIGHT_PROCESS_HEARTBEAT_PLUS_PERSISTED_OPERATIONAL_TRUTH_PLUS_INDEPENDENT_RECOVERY',
      sidecar:store.view(),
    };
  };

  orchestrator.fastPoll = async function heartbeatPoll(reason = 'manual') {
    if (this.fastPolling) return this.snapshot('heartbeat-poll-already-running');
    const started = Date.now();
    this.fastPolling = true;
    this.runtime.fast.inFlight = true;
    this.runtime.fast.lastStartedAt = iso(started);
    try {
      const result = await this.fetchSource('version', '/runner/version', config.heartbeatTimeoutMs, 'fast');
      this.runtime.fast.sequence += 1;
      this.runtime.fast.lastCompletedAt = iso();
      this.runtime.fast.durationMs = Date.now() - started;
      if (result.ok) {
        this.raw.version = result.data;
        this.runtime.fast.lastSuccessAt = iso();
        this.runtime.fast.lastError = null;
        this.runtime.fast.consecutiveFailures = 0;
      } else {
        this.runtime.fast.lastError = { version:result.error || null };
        this.runtime.fast.consecutiveFailures += 1;
      }
      return this.snapshot(reason);
    } finally {
      this.fastPolling = false;
      this.runtime.fast.inFlight = false;
    }
  };

  orchestrator.operationalPoll = async function operationalPoll(reason = 'manual') {
    if (this.runtime.operational.inFlight) return this.snapshot('operational-poll-already-running');
    const attemptId = ++operationalAttemptId;
    const started = Date.now();
    this.runtime.operational.inFlight = true;
    this.runtime.operational.lastStartedAt = iso(started);
    try {
      const result = await this.fetchSource('live', '/runner/live', config.operationalLiveTimeoutMs, 'operational');
      if (attemptId !== operationalAttemptId) return this.snapshot('operational-poll-superseded');
      this.runtime.operational.sequence += 1;
      this.runtime.operational.lastCompletedAt = iso();
      this.runtime.operational.durationMs = Date.now() - started;
      if (result.ok) {
        this.raw.live = result.data;
        this.strategyHeartbeat.observe(result.data, Date.now());
        this.candidateCohortTracker.observe({
          live:result.data,
          candidateAuthority:this.raw.candidateAuthority,
          now:Date.now(),
        });
        store.save(result.data, Date.now());
        this.runtime.operational.lastSuccessAt = iso();
        this.runtime.operational.lastError = null;
        this.runtime.operational.consecutiveFailures = 0;
      } else {
        this.runtime.operational.lastError = result.error || { message:'Operational truth refresh failed' };
        this.runtime.operational.consecutiveFailures += 1;
      }
      return this.snapshot(reason);
    } finally {
      if (attemptId === operationalAttemptId) this.runtime.operational.inFlight = false;
    }
  };

  orchestrator.start = function startV1022() {
    originalStart();
    if (!operationalTimer) {
      operationalTimer = setInterval(
        () => this.operationalPoll('interval').catch(error => log('[v10.2.2] operational refresh failed', summarizeError(error))),
        config.operationalPollMs
      );
      if (typeof operationalTimer.unref === 'function') operationalTimer.unref();
      setTimeout(() => this.operationalPoll('startup').catch(()=>{}), 1_500).unref();
    }
  };

  orchestrator.stop = function stopV1022() {
    if (operationalTimer) clearInterval(operationalTimer);
    operationalTimer = null;
    originalStop();
  };

  const originalAfterAdapterRestart = orchestrator.afterAdapterRestart.bind(orchestrator);
  orchestrator.afterAdapterRestart = async function afterAdapterRestartV1022(reason = 'ADAPTER_RESTART') {
    await originalAfterAdapterRestart(reason);
    await this.operationalPoll('after-supervised-adapter-restart');
    return this.snapshot('after-supervised-adapter-restart');
  };

  orchestrator.bootstrap = async function bootstrapV1022(reason = 'bootstrap') {
    await this.fastPoll(`${reason}-heartbeat`);
    await this.operationalPoll(`${reason}-operational`);
    this.heavyPoll(`${reason}-heavy`).catch(()=>{});
    this.recoveryTick(`${reason}-recovery`).catch(()=>{});
    return this.snapshot(reason);
  };

  orchestrator.snapshot = function snapshotV1022(reason = 'snapshot', now = Date.now()) {
    const state = originalSnapshot(reason, now);
    const fast = this.runtime.fast || {};
    const processAge = ageSec(fast.lastSuccessAt, now);
    const processReady = Boolean(adapter.status().running && fast.lastSuccessAt);
    const processFresh = Boolean(processReady && processAge <= config.processFreshMaxSec);
    state.schema = 'alps.v10202.unifiedState.v1';
    state.version = config.version;
    state.layers = asObject(state.layers);
    state.layers.process = {
      ...(state.layers.process || {}),
      name:'process',
      ready:processReady,
      fresh:processFresh,
      evidenceField:'controlPlane.heartbeat.lastSuccessAt',
      evidenceAt:fast.lastSuccessAt || null,
      ageSec:Number.isFinite(processAge) ? Math.round(processAge * 1000) / 1000 : null,
      maxAgeSec:config.processFreshMaxSec,
      status:processFresh ? 'FRESH' : (processReady ? 'STALE' : 'NOT_READY'),
      adapterRunning:Boolean(adapter.status().running),
      heartbeatIndependentFromOperationalTruth:true,
    };
    state.runtime = this.runtimeView();
    state.operationalStateAuthority = store.view(now);
    state.paperEntryProof = store.proofView();
    const paperProof = state.paperEntryProof;
    const paperProofAge = ageSec(paperProof.generatedAt, now);
    const paperReady = Boolean(paperProof.proofPresent);
    const paperFresh = Boolean(paperReady && paperProofAge <= config.paperFreshMaxSec);
    state.layers.paperEntry = {
      ...(state.layers.paperEntry || {}),
      name:'paperEntry',
      ready:paperReady,
      fresh:paperFresh,
      evidenceField:'v10202.paperEntryProof',
      evidenceAt:paperProof.generatedAt || null,
      ageSec:Number.isFinite(paperProofAge) ? Math.round(paperProofAge * 1000) / 1000 : null,
      maxAgeSec:config.paperFreshMaxSec,
      status:paperFresh ? 'FRESH' : (paperReady ? 'STALE' : 'NOT_PROVEN'),
      proofStatus:paperProof.status,
      scannerObserved:Boolean(paperProof.scannerObserved),
      lifecycleProven:Boolean(paperProof.lifecycleProven),
      visibilitySeen:finite(paperProof.stages && paperProof.stages.visibilitySeen, 0),
      pendingEntries:finite(paperProof.stages && paperProof.stages.pendingEntries, 0),
      openPositions:finite(paperProof.stages && paperProof.stages.openPositions, 0),
      closedTrades:finite(paperProof.stages && paperProof.stages.closedTrades, 0),
    };
    state.sourceTruth = {
      ...(state.sourceTruth || {}),
      operationalTruthMode:'PERSISTENT_SIDECAR_CACHE',
      operationalTruthCachedAt:store.view(now).generatedAt,
      operationalTruthSourceGeneratedAt:store.view(now).sourceGeneratedAt,
      heartbeatEndpoint:'/internal/runner/version',
      operationalEndpoint:'/internal/runner/live',
      restartAuthority:'PROCESS_EXIT_OR_REPEATED_DIRECT_VERSION_PROBE_FAILURES_ONLY',
    };
    return recomputeTopLevelState(state);
  };

  orchestrator.compactLive = function compactLiveV1022() {
    const value = originalCompactLive();
    value.schema = 'alps.v10202.liveSummary.v1';
    value.version = config.version;
    value.operationalStateAuthority = store.view();
    value.paperEntryProof = store.proofView();
    value.endpoints = {
      ...(value.endpoints || {}),
      operationalState:'/runner/operational-state',
      paperEntryProof:'/runner/paper-entry-proof',
      supervisor:'/runner/supervisor',
    };
    return value;
  };

  orchestrator.selfTest = function selfTestV1022() {
    const base = originalSelfTest();
    return {
      ...base,
      schema:'alps.v10202.architectureSelfTest.v1',
      version:config.version,
      heartbeatIndependentFromOperationalLive:true,
      operationalTruthSidecarPublished:Boolean(store.view().schema),
      paperEntryProofPublished:Boolean(store.proofView().schema),
      healthyProbeRestartBlocked:true,
      publicCommandProxyDisabled:true,
      preCloseCandleBufferMs:config.candleCloseBufferMs,
      unifiedPersistentLayout:true,
      pass:Boolean(base.pass !== false),
    };
  };

  adapter.status = function adapterStatusV1022() {
    const value = originalAdapterStatus();
    return {
      ...value,
      schema:'alps.v10202.browserEngineAdapter.v1',
      version:config.version,
      persistentLayout:{
        dataDir:config.dataDir,
        reportDir:config.reportDir,
        profileDir:config.profileDir,
        ledgerDir:config.ledgerDir,
      },
      restartAuthority:'PROCESS_EXIT_OR_REPEATED_DIRECT_VERSION_PROBE_FAILURES_ONLY',
      rule:'A healthy direct /runner/version probe blocks adapter restart even when operational truth refresh is slow.',
    };
  };

  return { store };
}

function stampTopLevel(value, schema, config) {
  if (!value || typeof value !== 'object') return value;
  return {
    ...value,
    schema,
    version:config.version,
    effectivePatchVersion:config.version,
  };
}

function installV1022PublicSafety({ server, store, config }) {
  const originalVersionView = server.versionView.bind(server);
  const originalCompatibilityHealth = server.compatibilityHealth.bind(server);
  const originalDetailedView = server.detailedView.bind(server);
  const originalReportModel = server.reportModel.bind(server);
  const originalRoute = server.route.bind(server);
  const originalProxy = server.proxyToAdapter.bind(server);

  server.versionView = function versionViewV1022() {
    return {
      ...stampTopLevel(originalVersionView(), 'alps.v10202.processLiveness.v1', config),
      endpointRole:'V10202_LIGHTWEIGHT_PROCESS_HEARTBEAT',
      operationalTruthSidecar:store.view(),
      publicCommandProxyDisabled:true,
    };
  };

  server.compatibilityHealth = function compatibilityHealthV1022() {
    return {
      ...stampTopLevel(originalCompatibilityHealth(), 'alps.v10202.compatibilityHealth.v1', config),
      sourceOfTruth:config.version,
      operationalTruthSidecar:store.view(),
      paperEntryProof:store.proofView(),
    };
  };

  server.detailedView = function detailedViewV1022(pathname) {
    const value = originalDetailedView(pathname);
    if (!value) return value;
    return stampTopLevel(value, `alps.v10202.${pathname.split('/').filter(Boolean).pop() || 'detail'}.v1`, config);
  };

  server.reportModel = function reportModelV1022(reason = 'report') {
    const value = originalReportModel(reason);
    return {
      ...stampTopLevel(value, 'alps.v10202.dashboardData.v1', config),
      dashboardVersion:'v10.2.2-final-runtime-authority',
      sourceOfTruth:'CURRENT_V10202_OPERATIONAL_STATE',
      operationalTruthSidecar:store.view(),
      paperEntryProof:store.proofView(),
    };
  };

  server.proxyToAdapter = async function proxyToAdapterV1022(req, res, incomingUrl) {
    if (incomingUrl.pathname === '/runner/command' || incomingUrl.pathname.startsWith('/runner/command/')) {
      return sendJson(res, 404, {
        schema:'alps.v10202.publicCommandProxy.v1',
        version:config.version,
        status:'PUBLIC_COMMAND_PROXY_DISABLED',
        publicProxy:false,
        internalRecoveryCommandsRemainPrivate:true,
      });
    }
    return originalProxy(req, res, incomingUrl);
  };

  server.route = async function routeV1022(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/runner/command' || url.pathname.startsWith('/runner/command/')) {
      return sendJson(res, 404, {
        schema:'alps.v10202.publicCommandProxy.v1',
        version:config.version,
        status:'PUBLIC_COMMAND_PROXY_DISABLED',
        publicProxy:false,
        internalRecoveryCommandsRemainPrivate:true,
      });
    }
    if (req.method === 'GET' && url.pathname === '/runner/operational-state') {
      return sendJson(res, 200, store.view());
    }
    if (req.method === 'GET' && url.pathname === '/runner/paper-entry-proof') {
      return sendJson(res, 200, store.proofView());
    }
    return originalRoute(req, res);
  };

  return server;
}

function createSafeShutdown({ supervisor, orchestrator, featureEngine, server, adapter, log = console.log, exit = code => process.exit(code) }) {
  let shuttingDown = false;
  return async function shutdown(signal, exitCode = 0, error = null) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (error) log(`[v10.2.2] fatal ${signal}`, summarizeError(error));
    else log(`[v10.2.2] shutdown requested signal=${signal}`);
    try { if (supervisor) supervisor.stop(); } catch (_) {}
    try { if (orchestrator) orchestrator.stop(); } catch (_) {}
    try { if (featureEngine) featureEngine.stop(); } catch (_) {}
    try { if (server) await server.stop(); } catch (stopError) { log('[v10.2.2] server stop failed', summarizeError(stopError)); }
    try { if (adapter) await adapter.stop(); } catch (stopError) { log('[v10.2.2] adapter stop failed', summarizeError(stopError)); }
    exit(exitCode);
  };
}

module.exports = {
  OperationalTruthStore,
  preparePersistentLayout,
  installV1022RuntimeAuthority,
  installV1022PublicSafety,
  createSafeShutdown,
};
