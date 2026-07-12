#!/usr/bin/env node
'use strict';

const { loadConfig } = require('./src/config');
const { BrowserEngineAdapter } = require('./src/browser-engine-adapter');
const { UnifiedOrchestrator } = require('./src/orchestrator');
const { PublicServer } = require('./src/server');
const { ServerFeatureEngine } = require('./src/server-feature-engine');
const { RuntimeSupervisor } = require('./src/runtime-supervisor');
const { summarizeError } = require('./src/utils');

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function main() {
  const config = loadConfig();
  log(`[v10.2.1] starting supervised continuous runtime version=${config.version}`);

  const adapter = new BrowserEngineAdapter(config, log);
  const featureEngine = new ServerFeatureEngine({ config, log });
  await featureEngine.init();

  const orchestrator = new UnifiedOrchestrator({
    config,
    adapter,
    featureEngine,
    log,
  });
  const supervisor = new RuntimeSupervisor({
    config,
    adapter,
    orchestrator,
    log,
  });
  orchestrator.attachSupervisor(supervisor);

  const server = new PublicServer({
    config,
    orchestrator,
    adapter,
    log,
  });

  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[v10.2.1] shutdown requested signal=${signal}`);
    supervisor.stop();
    orchestrator.stop();
    featureEngine.stop();
    await server.stop().catch(error => log('[v10.2.1] server stop failed', summarizeError(error)));
    await adapter.stop().catch(error => log('[v10.2.1] adapter stop failed', summarizeError(error)));
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', error => log('[v10.2.1] uncaughtException', summarizeError(error)));
  process.on('unhandledRejection', error => log('[v10.2.1] unhandledRejection', summarizeError(error)));

  await adapter.start();
  await server.start();
  featureEngine.start();
  orchestrator.start();
  supervisor.start();

  // Liveness is available immediately. Operational authority workers are independent:
  // fast health cannot be blocked by heavy evidence or recovery commands.
  adapter.waitUntilReady()
    .then(() => orchestrator.bootstrap('initial-adapter-ready'))
    .then(state => log(
      `[v10.2.1] initial state status=${state.status} ` +
      `overall=${state.gates.overall.status} next=${state.gates.overall.nextRequiredAction}`
    ))
    .catch(error => log(
      '[v10.2.1] initial adapter readiness failed; public control plane remains online',
      summarizeError(error)
    ));
}

main().catch(error => {
  console.error(new Date().toISOString(), '[v10.2.1] fatal startup error', summarizeError(error));
  process.exitCode = 1;
});
