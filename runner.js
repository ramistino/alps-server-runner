#!/usr/bin/env node
'use strict';

const { loadConfig } = require('./src/config');
const { BrowserEngineAdapter } = require('./src/browser-engine-adapter');
const { UnifiedOrchestrator } = require('./src/orchestrator');
const { PublicServer } = require('./src/server');
const { ServerFeatureEngine } = require('./src/server-feature-engine');
const { RuntimeSupervisor } = require('./src/runtime-supervisor');
const {
  preparePersistentLayout,
  installV1022RuntimeAuthority,
  installV1022PublicSafety,
  createSafeShutdown,
} = require('./src/v1022-runtime-authority');
const { summarizeError } = require('./src/utils');

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function main() {
  const config = loadConfig();
  const layout = preparePersistentLayout(config);
  log(`[v10.2.2] starting final runtime authority version=${config.version}`);
  log(`[v10.2.2] persistent root=${layout.root}`);

  const adapter = new BrowserEngineAdapter(config, log);
  const featureEngine = new ServerFeatureEngine({ config, log });
  await featureEngine.init();

  const orchestrator = new UnifiedOrchestrator({
    config,
    adapter,
    featureEngine,
    log,
  });
  const { store } = installV1022RuntimeAuthority({ orchestrator, adapter, config, log });

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
  installV1022PublicSafety({ server, store, config });

  const shutdown = createSafeShutdown({
    supervisor,
    orchestrator,
    featureEngine,
    server,
    adapter,
    log,
  });

  process.once('SIGTERM', () => shutdown('SIGTERM', 0));
  process.once('SIGINT', () => shutdown('SIGINT', 0));
  process.once('uncaughtException', error => shutdown('uncaughtException', 1, error));
  process.once('unhandledRejection', error => shutdown('unhandledRejection', 1, error));

  await adapter.start();
  await server.start();
  featureEngine.start();
  orchestrator.start();
  supervisor.start();

  // The public control plane is available immediately. The direct heartbeat and
  // operational truth sidecar are independent, so slow evidence cannot block liveness.
  adapter.waitUntilReady()
    .then(() => orchestrator.bootstrap('initial-adapter-ready'))
    .then(state => log(
      `[v10.2.2] initial state status=${state.status} ` +
      `overall=${state.gates.overall.status} next=${state.gates.overall.nextRequiredAction}`
    ))
    .catch(error => log(
      '[v10.2.2] initial adapter readiness failed; public control plane remains online',
      summarizeError(error)
    ));
}

main().catch(error => {
  console.error(new Date().toISOString(), '[v10.2.2] fatal startup error', summarizeError(error));
  process.exitCode = 1;
});
