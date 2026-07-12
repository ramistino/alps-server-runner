'use strict';

const http = require('http');
const { noCacheHeaders, summarizeError, text } = require('./utils');

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, value, extraHeaders = {}) {
  const raw = JSON.stringify(value, null, 2);
  res.writeHead(status, noCacheHeaders({
    'content-type':'application/json; charset=utf-8',
    'content-length':Buffer.byteLength(raw),
    'access-control-allow-origin':'*',
    'access-control-allow-methods':'GET,POST,OPTIONS',
    'access-control-allow-headers':'content-type,authorization',
    ...extraHeaders,
  }));
  res.end(raw);
}

function isAuthed(req, token) {
  if (!token) return true;
  const auth = text(req.headers.authorization);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return auth === `Bearer ${token}` || url.searchParams.get('token') === token;
}

class PublicServer {
  constructor({ config, orchestrator, adapter, log = console.log }) {
    this.config = config;
    this.orchestrator = orchestrator;
    this.adapter = adapter;
    this.log = log;
    this.server = null;
  }

  versionView() {
    const adapter = this.adapter.status();
    const runtime = this.orchestrator.runtimeView();
    return {
      schema:'alps.v10200.processLiveness.v2',
      version:this.config.version,
      effectivePatchVersion:this.config.version,
      status:'PROCESS_ALIVE',
      generatedAt:new Date().toISOString(),
      processPid:process.pid,
      processUptimeSec:Math.round(process.uptime()*1000)/1000,
      controlPlaneReady:true,
      browserEngineAdapterReady:adapter.running,
      browserEngineAdapter:adapter,
      runtimeWorkers:{
        architecture:runtime.architecture,
        fast:runtime.fast,
        heavy:runtime.heavy,
        recovery:runtime.recovery,
      },
      endpoint:'/runner/version',
      endpointRole:'V10200_CONTROL_PLANE_LIVENESS_ONLY',
      paperOnly:true,
      liveCapitalExecution:false,
      testnetExecution:false,
    };
  }

  compatibilityHealth() {
    const live = this.orchestrator.compactLive();
    const metrics = live.metrics || {};
    return {
      schema:'alps.v10200.compatibilityHealth.v2',
      version:this.config.version,
      generatedAt:live.generatedAt,
      sourceOfTruth:'v10.2.0-final-unified-runtime',
      status:live.status,
      engineReady:Boolean(live.layers && live.layers.process && live.layers.process.ready),
      labRunning:live.labRunning,
      fwRunning:live.paperLifecycleRunning,
      rawFwRunning:Boolean(this.orchestrator.raw.live && this.orchestrator.raw.live.rawFwRunning),
      researchReady:live.researchReady,
      currentHealthFresh:Boolean(live.layers && live.layers.process && live.layers.process.fresh),
      candidates:metrics.candidates || 0,
      officialCandidates:metrics.candidates || 0,
      nativePoolCandidates:metrics.nativePoolCandidates || 0,
      forwardLatchSize:metrics.forwardLatchSize || 0,
      paperEntryVisibilityCandidatesSeen:metrics.paperVisibilitySeen || 0,
      pendingEntries:metrics.pendingEntries || 0,
      openPositions:metrics.openPositions || 0,
      closedTrades:metrics.rawClosedTrades || 0,
      featureRowsFound:metrics.featureRowsFound || 0,
      freshFeaturePairFrames:metrics.freshFeaturePairFrames || 0,
      requiredFeaturePairFrames:metrics.requiredFeaturePairFrames || this.config.expectedPairFrames,
      featureCoverageStatus:live.layers && live.layers.featureEngine && live.layers.featureEngine.coverageStatus,
      finalHealthGate:live.gates && live.gates.overall,
      layerFreshness:live.layers,
      candidateAccounting:live.candidateAccounting,
      familyAdjustedStats:metrics.familyAdjustedStats,
      learningAuthorityStatus:live.learning && live.learning.status,
      paperOnly:true,
      liveCapitalExecution:false,
      testnetExecution:false,
      endpoints:live.endpoints,
    };
  }

  detailedView(pathname) {
    const state = this.orchestrator.snapshot(`route:${pathname}`);
    const map = {
      '/runner/features': () => ({
        schema:'alps.v10200.features.v2',
        version:this.config.version,
        generatedAt:state.generatedAt,
        layers:{
          candleBank:state.layers.candleBank,
          featureEngine:state.layers.featureEngine,
          strategyEngine:state.layers.strategyEngine,
          researchCycle:state.layers.researchCycle,
          chart:state.layers.chart,
        },
        gate:state.gates.research,
        recovery:state.recovery,
        serverFeatureEngine:state.serverFeatures ||
          (this.orchestrator.featureEngine && this.orchestrator.featureEngine.view()) || null,
        legacyFeatureAudit:{
          featureRowsFound:state.metrics.legacyFeatureRowsFound,
          freshFeaturePairFrames:state.metrics.legacyFreshFeaturePairFrames,
          sourceCandleDepth:this.orchestrator.raw.candleDepth || null,
        },
      }),
      '/runner/candidates': () => ({
        schema:'alps.v10200.candidates.v2',
        version:this.config.version,
        generatedAt:state.generatedAt,
        layer:state.layers.candidatePipeline,
        gate:state.gates.candidateAccounting,
        accounting:state.candidateAccounting,
        visibilityAudit:state.candidateVisibilityAudit || null,
        sourceAuthority:this.orchestrator.raw.candidateAuthority || null,
        nativePoolFetch:this.orchestrator.runtime.sources.nativePool || null,
      }),
      '/runner/lifecycle': () => ({
        schema:'alps.v10200.lifecycle.v2',
        version:this.config.version,
        generatedAt:state.generatedAt,
        layers:{
          paperEntry:state.layers.paperEntry,
          sentinel:state.layers.sentinel,
        },
        gate:state.gates.paperLifecycle,
        lifecycle:state.lifecycle,
      }),
      '/runner/learning': () => ({
        schema:'alps.v10200.learning.v2',
        version:this.config.version,
        generatedAt:state.generatedAt,
        layer:state.layers.learning,
        gate:state.gates.learning,
        learning:state.learning,
        familyAdjustedStats:state.familyAdjustedStats,
      }),
      '/runner/ledger-stats': () => ({
        schema:'alps.v10200.ledgerStats.v2',
        version:this.config.version,
        generatedAt:state.generatedAt,
        rawLedgerStats:state.metrics.rawLedgerStats,
        familyAdjustedStats:state.familyAdjustedStats,
        rule:'Family-adjusted current-epoch statistics are the performance authority. Raw ledger statistics remain audit-only.',
      }),
      '/runner/adapter': () => ({
        schema:'alps.v10200.adapterStatus.v2',
        version:this.config.version,
        generatedAt:state.generatedAt,
        adapter:this.adapter.status(),
        sourceVersion:this.orchestrator.raw.version,
        runtime:state.runtime,
      }),
    };
    return map[pathname] ? map[pathname]() : null;
  }

  async route(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, noCacheHeaders({
        'access-control-allow-origin':'*',
        'access-control-allow-methods':'GET,POST,OPTIONS',
        'access-control-allow-headers':'content-type,authorization',
      }));
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/runner/version') return sendJson(res, 200, this.versionView());
    if (pathname === '/runner/live' || pathname === '/runner/dashboard.json') {
      return sendJson(res, 200, this.orchestrator.compactLive());
    }
    if (
      pathname === '/runner/health-lite' ||
      pathname === '/runner/current-health-lite.json' ||
      pathname === '/runner/live-health.json'
    ) {
      return sendJson(res, 200, this.compatibilityHealth());
    }
    if (pathname === '/runner/health') {
      return sendJson(res, 200, this.orchestrator.snapshot('route:/runner/health'));
    }
    if (pathname === '/runner/self-test' || pathname === '/runner/v10200-self-test.json') {
      const test = this.orchestrator.selfTest();
      return sendJson(res, test.pass ? 200 : 503, test);
    }
    if (
      pathname === '/runner/acceptance' ||
      pathname === '/runner/operational-acceptance' ||
      pathname === '/runner/v10200-acceptance.json'
    ) {
      const acceptance = this.orchestrator.operationalAcceptance();
      return sendJson(res, acceptance.pass ? 200 : 503, acceptance);
    }

    const detailed = this.detailedView(pathname);
    if (detailed) {
      if (!isAuthed(req, this.config.token)) return sendJson(res, 401, { error:'Unauthorized' });
      return sendJson(res, 200, detailed);
    }

    if (pathname === '/runner/recover-research' && req.method === 'POST') {
      if (!isAuthed(req, this.config.token)) return sendJson(res, 401, { error:'Unauthorized' });
      const state = await this.orchestrator.forceResearchRecovery();
      return sendJson(res, 200, {
        ok:true,
        recovery:state.recovery,
        gates:state.gates,
        runtime:state.runtime,
      });
    }

    if (pathname === '/runner/chart' || pathname === '/runner/chart.json') {
      const pair=url.searchParams.get('pair') || 'BTCUSDT';
      const timeframe=url.searchParams.get('timeframe') || url.searchParams.get('tf') || '5m';
      const featureEngine=this.orchestrator.featureEngine;
      if (!featureEngine) {
        return sendJson(res,503,{
          schema:'alps.v10200.chartTruth.v2',
          status:'FEATURE_ENGINE_NOT_AVAILABLE',
          pair,
          timeframe,
          candles:[],
        });
      }
      return sendJson(res,200,featureEngine.chart(pair,timeframe));
    }

    return this.proxyToAdapter(req, res, url);
  }

  async proxyToAdapter(req, res, incomingUrl) {
    const target = new URL(incomingUrl.pathname + incomingUrl.search, this.config.internalBaseUrl);
    if (this.config.token && !target.searchParams.has('token')) {
      target.searchParams.set('token', this.config.token);
    }
    const body = ['GET','HEAD'].includes(req.method) ? undefined : await readBody(req);
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!['host','content-length','connection'].includes(key.toLowerCase()) && value !== undefined) {
        headers[key] = value;
      }
    }
    if (this.config.token) headers.authorization = `Bearer ${this.config.token}`;

    try {
      const response = await fetch(target, {
        method:req.method,
        headers,
        body,
        redirect:'manual',
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      const outHeaders = noCacheHeaders({ 'access-control-allow-origin':'*' });
      for (const [key, value] of response.headers.entries()) {
        if (!['content-length','transfer-encoding','connection','cache-control'].includes(key.toLowerCase())) {
          outHeaders[key] = value;
        }
      }
      outHeaders['content-length'] = buffer.length;
      res.writeHead(response.status, outHeaders);
      res.end(buffer);
    } catch (error) {
      sendJson(res, 502, {
        schema:'alps.v10200.proxyError.v2',
        error:summarizeError(error),
        adapter:this.adapter.status(),
      });
    }
  }

  async start() {
    this.server = http.createServer((req, res) => {
      this.route(req, res).catch(error => {
        this.log('[v10.2.0] public route error', summarizeError(error));
        if (!res.headersSent) sendJson(res, 500, { error:summarizeError(error) });
        else res.end();
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.publicPort, this.config.host, resolve);
    });
    this.log(`[v10.2.0] public control plane listening on ${this.config.host}:${this.config.publicPort}`);
    return this.server;
  }

  async stop() {
    if (!this.server) return;
    await new Promise(resolve => this.server.close(resolve));
    this.server = null;
  }
}

module.exports = { PublicServer, sendJson, isAuthed };
