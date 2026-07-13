'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = 'v10.2.2-final-runtime-authority';
const SCHEMA_PREFIX = 'alps.v10202';

function envNumber(name, fallback, min = -Infinity, max = Infinity) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function envPath(name, fallback) {
  const value = String(process.env[name] || '').trim();
  return path.resolve(value || fallback);
}

function detectPersistentRoot(rootDir) {
  const explicit = String(process.env.ALPS_PERSISTENT_DIR || '').trim();
  if (explicit) return path.resolve(explicit);
  if (fs.existsSync('/var/data')) return '/var/data/alps';
  const legacyDataDir = String(process.env.ALPS_DATA_DIR || '').trim();
  if (legacyDataDir) return path.resolve(legacyDataDir);
  return path.join(rootDir, 'data');
}

function loadConfig() {
  const publicPort = envNumber('PORT', envNumber('ALPS_RUNNER_PORT', 8787), 1, 65535);
  const internalPort = envNumber(
    'ALPS_BROWSER_ENGINE_PORT',
    publicPort === 65535 ? 65534 : publicPort + 1,
    1,
    65535
  );
  if (internalPort === publicPort) {
    throw new Error('ALPS_BROWSER_ENGINE_PORT must differ from PORT');
  }

  const rootDir = path.resolve(process.env.ALPS_V102_ROOT || path.join(__dirname, '..'));
  const persistentRoot = detectPersistentRoot(rootDir);
  const unifiedRootSelected = Boolean(
    String(process.env.ALPS_PERSISTENT_DIR || '').trim() ||
    fs.existsSync('/var/data')
  );
  const legacyDataDir = String(process.env.ALPS_DATA_DIR || '').trim();
  const dataDir = envPath(
    'ALPS_V102_DATA_DIR',
    unifiedRootSelected ? path.join(persistentRoot, 'state') : (legacyDataDir || persistentRoot)
  );
  const reportDir = envPath(
    'ALPS_V102_REPORT_DIR',
    unifiedRootSelected ? path.join(persistentRoot, 'reports') : (String(process.env.ALPS_REPORT_DIR || '').trim() || path.join(persistentRoot, 'reports'))
  );
  const profileDir = envPath(
    'ALPS_V102_PROFILE_DIR',
    unifiedRootSelected ? path.join(persistentRoot, 'chromium-profile') : (String(process.env.ALPS_PROFILE_DIR || '').trim() || path.join(persistentRoot, 'chromium-profile'))
  );
  const ledgerDir = envPath(
    'ALPS_V102_LEDGER_DIR',
    unifiedRootSelected ? path.join(persistentRoot, 'ledger') : (String(process.env.ALPS_LEDGER_DIR || '').trim() || path.join(persistentRoot, 'ledger'))
  );

  return {
    version:VERSION,
    schemaPrefix:SCHEMA_PREFIX,
    host:process.env.HOST || '0.0.0.0',
    publicPort,
    internalHost:'127.0.0.1',
    internalPort,
    internalBaseUrl:`http://127.0.0.1:${internalPort}`,
    token:String(process.env.ALPS_RUNNER_TOKEN || '').trim(),
    rootDir,
    legacyRunnerPath:path.join(rootDir, 'legacy', 'browser-engine-runner-v10158.js'),

    persistentRoot,
    dataDir,
    reportDir,
    profileDir,
    ledgerDir,
    operationalStateFile:path.join(dataDir, 'v10202-operational-truth.json'),
    paperEntryProofFile:path.join(dataDir, 'v10202-paper-entry-proof.json'),
    candidateCohortFile:path.join(dataDir, 'v102-candidate-cohort-authority.json'),
    candidateEpochFile:path.join(dataDir, 'v10202-candidate-epoch.json'),

    fastPollMs:envNumber('ALPS_V102_HEARTBEAT_POLL_MS', 5_000, 2_000, 30_000),
    heartbeatTimeoutMs:envNumber('ALPS_V102_HEARTBEAT_TIMEOUT_MS', 4_000, 1_000, 15_000),
    operationalPollMs:envNumber('ALPS_V102_OPERATIONAL_POLL_MS', 10_000, 5_000, 120_000),
    operationalLiveTimeoutMs:envNumber('ALPS_V102_OPERATIONAL_LIVE_TIMEOUT_MS', 15_000, 5_000, 60_000),
    operationalFreshMaxSec:envNumber('ALPS_V102_OPERATIONAL_FRESH_SEC', 90, 30, 900),
    operationalPersistIntervalMs:envNumber('ALPS_V102_OPERATIONAL_PERSIST_MS', 60_000, 10_000, 600_000),

    heavyPollMs:envNumber('ALPS_V102_HEAVY_POLL_MS', 60_000, 15_000, 300_000),
    recoveryPollMs:envNumber('ALPS_V102_RECOVERY_POLL_MS', 30_000, 10_000, 300_000),
    supervisorPollMs:envNumber('ALPS_V102_SUPERVISOR_POLL_MS', 10_000, 5_000, 60_000),

    fastVersionTimeoutMs:envNumber('ALPS_V102_VERSION_TIMEOUT_MS', 4_000, 1_000, 15_000),
    fastLiveTimeoutMs:envNumber('ALPS_V102_LIVE_TIMEOUT_MS', 12_000, 3_000, 30_000),
    fastHardDeadlineMs:envNumber('ALPS_V102_FAST_HARD_DEADLINE_MS', 18_000, 8_000, 60_000),
    supervisorProbeTimeoutMs:envNumber('ALPS_V102_SUPERVISOR_PROBE_TIMEOUT_MS', 4_000, 1_000, 15_000),
    fastStallSec:envNumber('ALPS_V102_FAST_STALL_SEC', 45, 20, 180),
    fastFailureRestartThreshold:envNumber('ALPS_V102_FAST_FAILURE_RESTART_THRESHOLD', 3, 2, 10),
    adapterRestartCooldownSec:envNumber('ALPS_V102_ADAPTER_RESTART_COOLDOWN_SEC', 120, 30, 900),
    adapterRestartReadyTimeoutMs:envNumber('ALPS_V102_ADAPTER_RESTART_READY_TIMEOUT_MS', 90_000, 20_000, 180_000),
    supervisorOperationalGraceSec:envNumber('ALPS_V102_SUPERVISOR_OPERATIONAL_GRACE_SEC', 90, 30, 600),
    operationalFailureRestartThreshold:envNumber('ALPS_V102_OPERATIONAL_FAILURE_RESTART_THRESHOLD', 6, 3, 30),

    tradesTimeoutMs:envNumber('ALPS_V102_TRADES_TIMEOUT_MS', 45_000, 10_000, 120_000),
    nativePoolTimeoutMs:envNumber('ALPS_V102_NATIVE_POOL_TIMEOUT_MS', 45_000, 10_000, 120_000),
    heavyHardDeadlineMs:envNumber('ALPS_V102_HEAVY_HARD_DEADLINE_MS', 60_000, 20_000, 180_000),
    heavyCircuitCooldownSec:envNumber('ALPS_V102_HEAVY_CIRCUIT_COOLDOWN_SEC', 600, 60, 3600),
    legacyHeavyAuditEnabled:String(process.env.ALPS_V102_LEGACY_HEAVY_AUDIT || '0') === '1',

    processFreshMaxSec:envNumber('ALPS_V102_PROCESS_FRESH_SEC', 30, 10, 180),
    sentinelFreshMaxSec:envNumber('ALPS_V102_SENTINEL_FRESH_SEC', 45, 10, 180),
    researchFreshMaxSec:envNumber('ALPS_V102_RESEARCH_FRESH_SEC', 180, 30, 900),
    learningFreshMaxSec:envNumber('ALPS_V102_LEARNING_FRESH_SEC', 180, 30, 900),
    paperFreshMaxSec:envNumber('ALPS_V102_PAPER_FRESH_SEC', 120, 30, 600),

    featureRecoveryEnabled:String(process.env.ALPS_V102_FEATURE_RECOVERY || '1') !== '0',
    autoStartResearch:String(process.env.ALPS_V102_AUTO_START_RESEARCH || '1') !== '0',
    recoveryCommandTimeoutMs:envNumber('ALPS_V102_RECOVERY_COMMAND_TIMEOUT_MS', 15_000, 5_000, 45_000),
    recoveryCooldownSec:envNumber('ALPS_V102_RECOVERY_COOLDOWN_SEC', 60, 20, 600),
    recoveryReloadSec:envNumber('ALPS_V102_RECOVERY_RELOAD_SEC', 600, 180, 3600),

    candidateGapConfirmObservations:envNumber('ALPS_V102_CANDIDATE_GAP_CONFIRM_OBSERVATIONS', 4, 2, 30),
    candidateGapConfirmSec:envNumber('ALPS_V102_CANDIDATE_GAP_CONFIRM_SEC', 20, 5, 600),

    candleCloseBufferMs:envNumber('ALPS_V102_CANDLE_CLOSE_BUFFER_MS', 5_000, 1_000, 30_000),
    expectedPairFrames:envNumber('ALPS_REQUIRED_PAIR_FRAMES', 35, 1, 1000),
    liveSummaryMaxBytes:envNumber('ALPS_V102_LIVE_MAX_BYTES', 160_000, 20_000, 1_000_000),
    childStartTimeoutMs:envNumber('ALPS_V102_CHILD_START_TIMEOUT_MS', 120_000, 10_000, 300_000),
  };
}

module.exports = { VERSION, SCHEMA_PREFIX, loadConfig, detectPersistentRoot };
