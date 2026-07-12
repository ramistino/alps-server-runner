'use strict';

const http = require('http');
const { noCacheHeaders, summarizeError, text } = require('./utils');

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('Request body too large')); req.destroy(); return; }
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
    const a = this.adapter.status();
    return {
      schema:'alps.v10200.processLiveness.v1',
      version:this.config.version,
      effectivePatchVersion:this.config.version,
      status:'PROCESS_ALIVE',
      generatedAt:new Date().toISOString(),
      processPid:process.pid,
      processUptimeSec:Math.round(process.uptime()*1000)/1000,
      controlPlaneReady:true,
      browserEngineAdapterReady:a.running,
      browserEngineAdapter:a,
      endpoint:'/runner/version',
      endpointRole:'V10200_CONTROL_PLANE_LIVENESS_ONLY',
      paperOnly:true,
      liveCapitalExecution:false,
      testnetExecution:false,
    };
  }

  compatibilityHealth() {
    const live = this.orchestrator.compactLive();
    const m = live.metrics || {};
    return {
      schema:'alps.v10200.compatibilityHealth.v1', version:this.config.version, generatedAt:live.generatedAt,
      sourceOfTruth:'v10.2.0-unified-control-plane', status:live.status,
      engineReady:Boolean(live.layers && live.layers.process && live.layers.process.ready),
      labRunning:live.labRunning,
      fwRunning:live.paperLifecycleRunning,
      rawFwRunning:Boolean(this.orchestrator.raw.live && this.orchestrator.raw.live.rawFwRunning),
      researchReady:live.researchReady,
      currentHealthFresh:Boolean(live.layers && live.layers.process && live.layers.process.fresh),
      candidates:m.candidates || 0,
      officialCandidates:m.candidates || 0,
      nativePoolCandidates:m.nativePoolCandidates || 0,
      forwardLatchSize:m.forwardLatchSize || 0,
      paperEntryVisibilityCandidatesSeen:m.paperVisibilitySeen || 0,
      pendingEntries:m.pendingEntries || 0,
      openPositions:m.openPositions || 0,
      closedTrades:m.rawClosedTrades || 0,
      featureRowsFound:m.featureRowsFound || 0,
      freshFeaturePairFrames:m.freshFeaturePairFrames || 0,
      requiredFeaturePairFrames:m.requiredFeaturePairFrames || this.config.expectedPairFrames,
      featureCoverageStatus:live.layers && live.layers.featureEngine && live.layers.featureEngine.coverageStatus,
      finalHealthGate:live.gates && live.gates.overall,
      layerFreshness:live.layers,
      candidateAccounting:live.candidateAccounting,
      familyAdjustedStats:m.familyAdjustedStats,
      learningAuthorityStatus:live.learning && live.learning.status,
      paperOnly:true, liveCapitalExecution:false, testnetExecution:false,
      endpoints:live.endpoints,
    };
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
    if (pathname === '/runner/live' || pathname === '/runner/dashboard.json') return sendJson(res, 200, this.orchestrator.compactLive());
    if (pathname === '/runner/health-lite' || pathname === '/runner/current-health-lite.json' || pathname === '/runner/live-health.json') return sendJson(res, 200, this.compatibilityHealth());
    if (pathname === '/runner/health') return sendJson(res, 200, this.orchestrator.state);
    if (pathname === '/runner/self-test' || pathname === '/runner/v10200-self-test.json') {
      const test = this.orchestrator.selfTest();
      return sendJson(res, test.pass ? 200 : 503, test);
    }

    const detailed = {
      '/runner/features': () => ({ schema:'alps.v10200.features.v1', version:this.config.version, generatedAt:new Date().toISOString(),
        layers:{ candleBank:this.orchestrator.state.layers.candleBank, featureEngine:this.orchestrator.state.layers.featureEngine, strategyEngine:this.orchestrator.state.layers.strategyEngine, researchCycle:this.orchestrator.state.layers.researchCycle, chart:this.orchestrator.state.layers.chart },
        gate:this.orchestrator.state.gates.research, recovery:this.orchestrator.state.recovery,
        serverFeatureEngine:this.orchestrator.state.serverFeatures || (this.orchestrator.featureEngine && this.orchestrator.featureEngine.view()) || null,
        legacyFeatureAudit:{ featureRowsFound:this.orchestrator.state.metrics.legacyFeatureRowsFound, freshFeaturePairFrames:this.orchestrator.state.metrics.legacyFreshFeaturePairFrames, sourceCandleDepth:this.orchestrator.raw.candleDepth || null } }),
      '/runner/candidates': () => ({ schema:'alps.v10200.candidates.v1', version:this.config.version, generatedAt:new Date().toISOString(),
        layer:this.orchestrator.state.layers.candidatePipeline, gate:this.orchestrator.state.gates.candidateAccounting,
        accounting:this.orchestrator.state.candidateAccounting, visibilityAudit:this.orchestrator.state.candidateVisibilityAudit || null, sourceAuthority:this.orchestrator.raw.candidateAuthority || null }),
      '/runner/lifecycle': () => ({ schema:'alps.v10200.lifecycle.v1', version:this.config.version, generatedAt:new Date().toISOString(),
        layers:{ paperEntry:this.orchestrator.state.layers.paperEntry, sentinel:this.orchestrator.state.layers.sentinel },
        gate:this.orchestrator.state.gates.paperLifecycle, lifecycle:this.orchestrator.state.lifecycle }),
      '/runner/learning': () => ({ schema:'alps.v10200.learning.v1', version:this.config.version, generatedAt:new Date().toISOString(),
        layer:this.orchestrator.state.layers.learning, gate:this.orchestrator.state.gates.learning,
        learning:this.orchestrator.state.learning, familyAdjustedStats:this.orchestrator.state.familyAdjustedStats }),
      '/runner/ledger-stats': () => ({ schema:'alps.v10200.ledgerStats.v1', version:this.config.version, generatedAt:new Date().toISOString(),
        rawLedgerStats:this.orchestrator.state.metrics.rawLedgerStats,
        familyAdjustedStats:this.orchestrator.state.familyAdjustedStats,
        rule:'Family-adjusted current-epoch statistics are the performance authority. Raw ledger statistics remain audit-only.' }),
      '/runner/adapter': () => ({ schema:'alps.v10200.adapterStatus.v1', version:this.config.version, generatedAt:new Date().toISOString(), adapter:this.adapter.status(), sourceVersion:this.orchestrator.raw.version }),
    };
    if (detailed[pathname]) {
      if (!isAuthed(req, this.config.token)) return sendJson(res, 401, { error:'Unauthorized' });
      return sendJson(res, 200, detailed[pathname]());
    }

    if (pathname === '/runner/recover-research' && req.method === 'POST') {
      if (!isAuthed(req, this.config.token)) return sendJson(res, 401, { error:'Unauthorized' });
      const state = await this.orchestrator.forceResearchRecovery();
      return sendJson(res, 200, { ok:true, recovery:state.recovery, gates:state.gates });
    }
    if (pathname === '/runner/chart' || pathname === '/runner/chart.json') {
      const pair=url.searchParams.get('pair') || 'BTCUSDT';
      const timeframe=url.searchParams.get('timeframe') || url.searchParams.get('tf') || '5m';
      const featureEngine=this.orchestrator.featureEngine;
      if (!featureEngine) return sendJson(res,503,{schema:'alps.v10200.chartTruth.v1',status:'FEATURE_ENGINE_NOT_AVAILABLE',pair,timeframe,candles:[]});
      return sendJson(res,200,featureEngine.chart(pair,timeframe));
    }

    return this.proxyToAdapter(req, res, url);
  }

  async proxyToAdapter(req, res, incomingUrl) {
    const target = new URL(incomingUrl.pathname + incomingUrl.search, this.config.internalBaseUrl);
    if (this.config.token && !target.searchParams.has('token')) target.searchParams.set('token', this.config.token);
    const body = ['GET','HEAD'].includes(req.method) ? undefined : await readBody(req);
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!['host','content-length','connection'].includes(key.toLowerCase()) && value !== undefined) headers[key] = value;
    }
    if (this.config.token) headers.authorization = `Bearer ${this.config.token}`;
    try {
      const response = await fetch(target, { method:req.method, headers, body, redirect:'manual' });
      const buffer = Buffer.from(await response.arrayBuffer());
      const outHeaders = noCacheHeaders({ 'access-control-allow-origin':'*' });
      for (const [key, value] of response.headers.entries()) {
        if (!['content-length','transfer-encoding','connection','cache-control'].includes(key.toLowerCase())) outHeaders[key] = value;
      }
      outHeaders['content-length'] = buffer.length;
      res.writeHead(response.status, outHeaders);
      res.end(buffer);
    } catch (error) {
      sendJson(res, 502, { schema:'alps.v10200.proxyError.v1', error:summarizeError(error), adapter:this.adapter.status() });
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
