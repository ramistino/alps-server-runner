'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { VERSION, SCHEMA_PREFIX, loadConfig, detectPersistentRoot } = require('../src/config');
const { RuntimeSupervisor } = require('../src/runtime-supervisor');
const { closedOnly, TF_MS } = require('../src/server-feature-engine');
const {
  OperationalTruthStore,
  installV1022PublicSafety,
} = require('../src/v1022-runtime-authority');

function tempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alps-v1022-'));
  return {
    version:VERSION,
    operationalStateFile:path.join(root, 'state.json'),
    paperEntryProofFile:path.join(root, 'proof.json'),
  };
}

function mockResponse() {
  return {
    statusCode:null,
    headers:null,
    body:'',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(value = '') {
      this.body += Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
    },
  };
}

function supervisorConfig() {
  return {
    version:VERSION,
    supervisorPollMs:10_000,
    supervisorProbeTimeoutMs:100,
    fastHardDeadlineMs:1_000,
    heavyHardDeadlineMs:1_000,
    fastStallSec:45,
    operationalFreshMaxSec:90,
    operationalFailureRestartThreshold:3,
    fastFailureRestartThreshold:3,
    adapterRestartCooldownSec:0,
  };
}

test('v10.2.2 version and schema are authoritative', () => {
  assert.equal(VERSION, 'v10.2.2-final-runtime-authority');
  assert.equal(SCHEMA_PREFIX, 'alps.v10202');
});

test('explicit persistent root has priority', () => {
  const prior = process.env.ALPS_PERSISTENT_DIR;
  process.env.ALPS_PERSISTENT_DIR = '/tmp/alps-explicit-root';
  try {
    assert.equal(detectPersistentRoot('/app'), '/tmp/alps-explicit-root');
  } finally {
    if (prior === undefined) delete process.env.ALPS_PERSISTENT_DIR;
    else process.env.ALPS_PERSISTENT_DIR = prior;
  }
});

test('loadConfig publishes a five-second candle close buffer', () => {
  const config = loadConfig();
  assert.ok(config.candleCloseBufferMs >= 1_000);
  assert.equal(config.version, VERSION);
});

test('candidate and latch counts alone do not prove Paper Entry', () => {
  const store = new OperationalTruthStore({ config:tempConfig(), log:()=>{} });
  const proof = store.derivePaperEntryProof({
    candidates:220,
    nativePoolCandidates:220,
    forwardLatchSize:220,
    paperEntryVisibilityCandidatesSeen:0,
    openPositions:0,
    closedTrades:0,
    currentHealth:{ pendingEntries:0 },
  });
  assert.equal(proof.proofPresent, false);
  assert.equal(proof.lifecycleProven, false);
  assert.equal(proof.status, 'PAPER_ENTRY_VISIBILITY_NOT_YET_PROVEN');
});


test('scanner timestamp proves Paper Entry scanner activity even with zero candidates', () => {
  const store = new OperationalTruthStore({ config:tempConfig(), log:()=>{} });
  const proof = store.derivePaperEntryProof({
    candidates:0,
    nativePoolCandidates:0,
    forwardLatchSize:0,
    paperEntryVisibilityCandidatesSeen:0,
    openPositions:0,
    closedTrades:0,
    currentHealth:{
      pendingEntries:0,
      paperEntryVisibilityLastScanAt:new Date().toISOString(),
    },
  });
  assert.equal(proof.proofPresent, true);
  assert.equal(proof.scannerObserved, true);
  assert.equal(proof.lifecycleProven, false);
  assert.equal(proof.status, 'PAPER_ENTRY_SCANNER_ACTIVE_ZERO_OR_MORE_CANDIDATES');
});

test('pending, open, or closed lifecycle evidence proves Paper Entry', () => {
  const store = new OperationalTruthStore({ config:tempConfig(), log:()=>{} });
  const proof = store.derivePaperEntryProof({
    candidates:1,
    nativePoolCandidates:1,
    forwardLatchSize:1,
    openPositions:1,
    currentHealth:{ pendingEntries:0 },
  });
  assert.equal(proof.proofPresent, true);
  assert.equal(proof.lifecycleProven, true);
  assert.equal(proof.status, 'PAPER_ENTRY_LIFECYCLE_PROVEN');
});

test('operational truth and Paper Entry proof survive a store reload', () => {
  const config = tempConfig();
  const first = new OperationalTruthStore({ config, log:()=>{} });
  first.save({
    generatedAt:new Date().toISOString(),
    candidates:4,
    nativePoolCandidates:4,
    forwardLatchSize:4,
    paperEntryVisibilityCandidatesSeen:2,
    currentHealth:{ pendingEntries:1 },
  });
  const second = new OperationalTruthStore({ config, log:()=>{} });
  assert.equal(second.view().cacheLoadedFromDisk, true);
  assert.equal(second.cachedLive().candidates, 4);
  assert.equal(second.proofView().proofPresent, true);
  assert.equal(fs.existsSync(config.operationalStateFile), true);
  assert.equal(fs.existsSync(config.paperEntryProofFile), true);
});

test('public /runner/command is blocked before adapter proxying', async () => {
  let proxied = false;
  const config = { version:VERSION };
  const store = new OperationalTruthStore({ config:tempConfig(), log:()=>{} });
  const server = {
    versionView:()=>({}),
    compatibilityHealth:()=>({}),
    detailedView:()=>null,
    reportModel:()=>({}),
    route:async()=>{ throw new Error('original route must not run'); },
    proxyToAdapter:async()=>{ proxied = true; },
  };
  installV1022PublicSafety({ server, store, config });
  const res = mockResponse();
  await server.route({ method:'POST', url:'/runner/command', headers:{ host:'localhost' } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(proxied, false);
  assert.equal(JSON.parse(res.body).status, 'PUBLIC_COMMAND_PROXY_DISABLED');
});

test('healthy direct probe blocks restart despite operational degradation', async () => {
  let restartCount = 0;
  let recoveryCount = 0;
  const now = new Date().toISOString();
  const adapter = {
    status:()=>({ running:true }),
    probe:async()=>({ ok:true }),
    restart:async()=>{ restartCount += 1; },
  };
  const orchestrator = {
    runtimeView:()=>({
      fast:{ lastSuccessAt:now, inFlight:false },
      operational:{ lastSuccessAt:null, consecutiveFailures:2 },
      heavy:{ inFlight:false },
    }),
    snapshot:()=>({
      layers:{
        featureEngine:{ fresh:true },
        strategyEngine:{ fresh:false },
        researchCycle:{ fresh:false },
        sentinel:{ fresh:false },
      },
    }),
    expireFastAttempt:()=>{},
    fastPoll:async()=>({}),
    openHeavyCircuit:()=>{},
    recoveryTick:async()=>{ recoveryCount += 1; },
    afterAdapterRestart:async()=>{},
  };
  const supervisor = new RuntimeSupervisor({ config:supervisorConfig(), adapter, orchestrator, log:()=>{} });
  await supervisor.tick('test');
  assert.equal(restartCount, 0);
  assert.equal(recoveryCount, 1);
  assert.equal(supervisor.status().restartAuthority, 'PROCESS_EXIT_OR_REPEATED_DIRECT_VERSION_PROBE_FAILURES_ONLY');
});

test('three repeated direct probe failures allow one controlled restart', async () => {
  let restartCount = 0;
  let afterRestartCount = 0;
  const now = new Date().toISOString();
  const adapter = {
    status:()=>({ running:true }),
    probe:async()=>({ ok:false, status:0 }),
    restart:async()=>{ restartCount += 1; },
  };
  const orchestrator = {
    runtimeView:()=>({
      fast:{ lastSuccessAt:now, inFlight:false },
      operational:{ lastSuccessAt:now, consecutiveFailures:0 },
      heavy:{ inFlight:false },
    }),
    snapshot:()=>({
      layers:{
        featureEngine:{ fresh:true },
        strategyEngine:{ fresh:true },
        researchCycle:{ fresh:true },
        sentinel:{ fresh:true },
      },
    }),
    expireFastAttempt:()=>{},
    fastPoll:async()=>({}),
    openHeavyCircuit:()=>{},
    recoveryTick:async()=>{},
    afterAdapterRestart:async()=>{ afterRestartCount += 1; },
  };
  const supervisor = new RuntimeSupervisor({ config:supervisorConfig(), adapter, orchestrator, log:()=>{} });
  await supervisor.tick('one');
  await supervisor.tick('two');
  assert.equal(restartCount, 0);
  await supervisor.tick('three');
  assert.equal(restartCount, 1);
  assert.equal(afterRestartCount, 1);
});

test('closedOnly excludes a candle until the safety buffer has elapsed', () => {
  const now = 1_000_000;
  const ms = TF_MS['5m'];
  const candleJustClosed = { openTime:now-ms, open:1, high:2, low:1, close:2, volume:1 };
  const olderCandle = { openTime:now-(2*ms), open:1, high:2, low:1, close:2, volume:1 };
  const withinBuffer = closedOnly([olderCandle,candleJustClosed], '5m', now+1_000, 5_000);
  const afterBuffer = closedOnly([olderCandle,candleJustClosed], '5m', now+6_000, 5_000);
  assert.equal(withinBuffer.length, 1);
  assert.equal(afterBuffer.length, 2);
});
