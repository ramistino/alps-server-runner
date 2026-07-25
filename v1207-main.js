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
} = require('./policy-shadow-integrity-v12072');

function iso(value = Date.now()) { return new Date(value).toISOString(); }
function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type':'application/json; charset=utf-8',
    'content-length':Buffer.byteLength(text),
    'cache-control':'no-store',
    'access-control-allow-origin':'*',
    'x-content-type-options':'nosniff',
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

class PolicyShadowServer extends MultiMarketServer {
  constructor({ config, engine, policyShadow, log = console.log }) {
    super({ config, engine, log });
    this.policyShadow = policyShadow;
  }
  versionView() {
    const view = this.engine.view();
    return {
      schema:'alps.runner.version.v1207',
      version:SERVICE_VERSION,
      candidateEngineVersion:CONTROL_VERSION,
      shadowPolicyEngineVersion:SHADOW_VERSION,
      integrityPatchVersion:INTEGRITY_PATCH_VERSION,
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
      cryptoContinuity:view.crypto.continuity,
      cryptoForwardShadow:view.crypto.forwardShadow,
      forexBudget:view.forex.budget,
      forexScheduler:view.forex.scheduler,
      forexLease:view.forex.lease,
      cryptoProvider:view.crypto.provider,
      evidenceScoring:view.crypto.evidenceScoring,
      policyShadow:this.policyShadow.view(),
      memory:view.memory,
    };
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
      return sendJson(res, 200, this.policyShadow.armsView());
    }
    if (req.method === 'GET' && url.pathname === '/runner/policy-shadow/comparisons') {
      return sendJson(res, 200, this.policyShadow.comparisonsView());
    }
    if (req.method === 'GET' && url.pathname === '/runner/policy-shadow/diagnostics') {
      return sendJson(res, 200, this.policyShadow.diagnosticsView());
    }
    if (req.method === 'GET' && url.pathname === '/runner/policy-shadow/snapshots') {
      return sendJson(res, 200, {
        schema:'alps.gen2.policyShadowSnapshotsTail.v12052',
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
        if (command === 'refresh-forex') {
          return sendJson(res, 200, await this.engine.forex.refreshAll('private-command'));
        }
        if (command === 'refresh-crypto') {
          return sendJson(res, 200, await this.engine.crypto.refreshAll('private-command'));
        }
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
        if (command === 'score-evidence') {
          return sendJson(res, 200, await this.engine.crypto.evidenceScorer.run('private-command'));
        }
        if (command === 'run-policy-shadow') {
          return sendJson(res, 200, await this.policyShadow.run('private-command'));
        }
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
  log('[v12.0.7] policy-shadow hook installed after certified candidate cycles');
}

async function main() {
  const config = loadConfig();
  const startupAt = iso();
  const log = (...args) => console.log(new Date().toISOString(), ...args);
  log(`[v12.0.7] starting ${SERVICE_VERSION}`);
  log(`[v12.0.7.2] certified control=${CONTROL_VERSION} shadow=${SHADOW_VERSION} integrity=${INTEGRITY_PATCH_VERSION}`);
  log(`[v12.0.7] mode=PRE_REGISTERED_POLICY_SHADOW paperOnly=true execution=false promotion=false`);
  log(`[v12.0.7] roots v12=${config.dataRoot} v11=${config.legacyRoot} (read-only)`);

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
    log(`[v12.0.7] shutdown ${signal}`);
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
  log('[v12.0.7] control plane ready; certified workers initialize without mutation');
  (async () => {
    try {
      await engine.init();
      await policyShadow.init();
      installCandidateCycleHook(engine, policyShadow, log);
      policyShadow.startFallback();
      await policyShadow.run('startup-post-manifest-catchup');
      if (!stopping) log(`[v12.0.7] workers online status=${engine.statusValue()} policy=${policyShadow.view().status}`);
    } catch (error) {
      engine.status = 'DEGRADED_INITIALIZATION_FAILED';
      engine.lastError = String(error.stack || error).slice(0, 2400);
      log('[v12.0.7] initialization failed', error.stack || error);
    }
  })();
  return { config, engine, policyShadow, server };
}

module.exports = { main, PolicyShadowServer, installViews, installCandidateCycleHook };
