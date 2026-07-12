'use strict';

const path = require('path');

const VERSION = 'v10.2.0-unified-research-control-plane';
const SCHEMA_PREFIX = 'alps.v10200';

function envNumber(name, fallback, min = -Infinity, max = Infinity) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function loadConfig() {
  const publicPort = envNumber('PORT', envNumber('ALPS_RUNNER_PORT', 8787), 1, 65535);
  const internalPort = envNumber('ALPS_BROWSER_ENGINE_PORT', publicPort === 65535 ? 65534 : publicPort + 1, 1, 65535);
  if (internalPort === publicPort) throw new Error('ALPS_BROWSER_ENGINE_PORT must differ from PORT');
  const rootDir = path.resolve(process.env.ALPS_V102_ROOT || path.join(__dirname, '..'));
  return {
    version: VERSION,
    schemaPrefix: SCHEMA_PREFIX,
    host: process.env.HOST || '0.0.0.0',
    publicPort,
    internalHost: '127.0.0.1',
    internalPort,
    internalBaseUrl: `http://127.0.0.1:${internalPort}`,
    token: String(process.env.ALPS_RUNNER_TOKEN || '').trim(),
    rootDir,
    legacyRunnerPath: path.join(rootDir, 'legacy', 'browser-engine-runner-v10158.js'),
    pollMs: envNumber('ALPS_V102_POLL_MS', 10_000, 2_000, 60_000),
    processFreshMaxSec: envNumber('ALPS_V102_PROCESS_FRESH_SEC', 45, 10, 300),
    sentinelFreshMaxSec: envNumber('ALPS_V102_SENTINEL_FRESH_SEC', 30, 5, 180),
    researchFreshMaxSec: envNumber('ALPS_V102_RESEARCH_FRESH_SEC', 180, 30, 900),
    learningFreshMaxSec: envNumber('ALPS_V102_LEARNING_FRESH_SEC', 180, 30, 900),
    paperFreshMaxSec: envNumber('ALPS_V102_PAPER_FRESH_SEC', 90, 15, 600),
    featureRecoveryEnabled: String(process.env.ALPS_V102_FEATURE_RECOVERY || '1') !== '0',
    autoStartResearch: String(process.env.ALPS_V102_AUTO_START_RESEARCH || '1') !== '0',
    featureRecoverySoftSec: envNumber('ALPS_V102_FEATURE_RECOVERY_SOFT_SEC', 20, 5, 300),
    featureRecoveryWatchdogSec: envNumber('ALPS_V102_FEATURE_RECOVERY_WATCHDOG_SEC', 75, 15, 600),
    featureRecoveryReloadSec: envNumber('ALPS_V102_FEATURE_RECOVERY_RELOAD_SEC', 360, 120, 1800),
    expectedPairFrames: envNumber('ALPS_REQUIRED_PAIR_FRAMES', 35, 1, 1000),
    liveSummaryMaxBytes: envNumber('ALPS_V102_LIVE_MAX_BYTES', 80_000, 20_000, 1_000_000),
    childStartTimeoutMs: envNumber('ALPS_V102_CHILD_START_TIMEOUT_MS', 120_000, 10_000, 300_000),
  };
}

module.exports = { VERSION, SCHEMA_PREFIX, loadConfig };
