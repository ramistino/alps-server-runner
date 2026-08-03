'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const {
  SafeStorage,
  PersistenceQueue,
} = require('./v1202-bundle');

const {
  PolicyShadowEngine,
  stableHash,
} = require('./policy-shadow-v12052');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testSerializedQueueUnder256Mb() {
  let active = 0;
  let maxActive = 0;
  let physicalWrites = 0;
  let finalPayload = null;
  const optionRows = [];

  const storage = {
    async writeJsonAtomic(file, payload, options = {}) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      physicalWrites += 1;
      optionRows.push(options);
      await delay(4);
      finalPayload = String(payload);
      active -= 1;
    },
  };

  const queue = new PersistenceQueue({
    storage,
    retryDelayMs:5,
    maxRetryDelayMs:20,
  });

  const originalStructuredClone = global.structuredClone;
  global.structuredClone = () => {
    throw new Error('STRUCTURED_CLONE_MUST_NOT_RUN_ON_SERIALIZED_PATH');
  };

  const before = process.memoryUsage().heapUsed;
  const sharedBlob = 'x'.repeat(1024 * 1024);
  const waits = [];

  try {
    for (let index = 0; index < 55; index += 1) {
      const serialized = JSON.stringify({
        index,
        sharedBlob,
        paperOnly:true,
        executionEnabled:false,
        liveCapitalExecution:false,
        promotionEnabled:false,
      });
      waits.push(
        queue.enqueueSerializedJson(
          '/virtual/policy-state.json',
          serialized,
          { durable:true },
        ).done,
      );
    }

    const results = await Promise.all(waits);
    assert(results.every(result => result && result.ok === true));
  } finally {
    global.structuredClone = originalStructuredClone;
  }

  if (global.gc) {
    global.gc();
    await delay(10);
    global.gc();
  }

  const after = process.memoryUsage().heapUsed;
  const growthMb = (after - before) / 1048576;

  assert.strictEqual(maxActive, 1);
  assert(physicalWrites >= 1);
  assert(physicalWrites < 55);
  assert(optionRows.every(row => row.serialized === true));
  assert.strictEqual(JSON.parse(finalPayload).index, 54);
  assert(
    growthMb < 96,
    `Expected bounded heap growth below 96MB, observed ${growthMb.toFixed(2)}MB`,
  );

  const appendStorage = {
    lines:null,
    async appendNdjsonLines(file, lines) {
      this.lines = lines;
    },
  };
  const appendQueue = new PersistenceQueue({ storage:appendStorage });

  const originalCloneAgain = global.structuredClone;
  global.structuredClone = () => {
    throw new Error('STRUCTURED_CLONE_MUST_NOT_RUN_ON_SERIALIZED_APPEND');
  };

  try {
    const result = await appendQueue.enqueueAppendSerialized(
      '/virtual/snapshots.ndjson',
      JSON.stringify({ snapshotId:'PS52-SERIALIZED' }),
      { durable:true },
    ).done;
    assert.strictEqual(result.ok, true);
  } finally {
    global.structuredClone = originalCloneAgain;
  }

  assert.deepStrictEqual(
    appendStorage.lines,
    ['{"snapshotId":"PS52-SERIALIZED"}'],
  );
}

async function testAtomicFailureSafety() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'alps-m4-atomic-'));
  const config = {
    dataRoot:root,
    legacyRoot:path.join(root, 'legacy'),
  };
  const storage = new SafeStorage(config);
  const file = path.join(root, 'state', 'policy.json');

  await storage.writeJsonAtomic(
    file,
    '{"revision":1}',
    { serialized:true },
  );

  const originalRename = fs.promises.rename;
  fs.promises.rename = async () => {
    throw new Error('FORCED_RENAME_FAILURE');
  };

  try {
    await assert.rejects(
      storage.writeJsonAtomic(
        file,
        '{"revision":2}',
        { serialized:true },
      ),
      /FORCED_RENAME_FAILURE/,
    );
  } finally {
    fs.promises.rename = originalRename;
  }

  assert.deepStrictEqual(
    JSON.parse(await fsp.readFile(file, 'utf8')),
    { revision:1 },
  );

  const files = await fsp.readdir(path.dirname(file));
  assert.strictEqual(
    files.some(name => name.endsWith('.tmp')),
    false,
  );

  await fsp.rm(root, { recursive:true, force:true });
}

async function testLegacyMigrationAndViewParity() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'alps-m4-migrate-'));
  const evidenceDir = path.join(root, 'evidence');
  const stateDir = path.join(root, 'state');
  const cleanDir = path.join(root, 'crypto', 'clean');

  await Promise.all([
    fsp.mkdir(evidenceDir, { recursive:true }),
    fsp.mkdir(stateDir, { recursive:true }),
    fsp.mkdir(cleanDir, { recursive:true }),
  ]);

  const config = {
    dataRoot:root,
    legacyRoot:path.join(root, 'legacy'),
    crypto:{
      cleanDir,
      certifiedCandidateLedgerFile:path.join(
        evidenceDir,
        'crypto-forward-shadow-ledger-v12051.ndjson',
      ),
      candidateLedgerFile:path.join(
        evidenceDir,
        'crypto-forward-shadow-ledger-v12051.ndjson',
      ),
    },
  };

  const storage = new SafeStorage(config);
  const queue = new PersistenceQueue({
    storage,
    retryDelayMs:5,
    maxRetryDelayMs:20,
  });

  const now = () => Date.parse('2026-08-04T00:00:00.000Z');
  const engine = new PolicyShadowEngine({
    config,
    storage,
    persistQueue:queue,
    now,
    startupAt:'2026-08-04T00:00:00.000Z',
    controlViewProvider:() => null,
    scoringViewProvider:() => null,
  });

  const epoch = '2026-07-24T18:01:37.185Z';
  const body = engine.policyBody(epoch, null);
  const policyHash = stableHash(body);
  const manifest = {
    schema:'alps.gen2.entryExitPolicyShadowManifest.v12052',
    manifestVersion:'v1.1',
    ...body,
    policyHash,
    manifestSha256:stableHash({ ...body, policyHash }),
    status:'FROZEN_FOR_IMPLEMENTATION',
    createdFromSourceEventAt:null,
  };

  const snapshot = {
    schema:'alps.gen2.entryExitPolicyShadowSnapshot.v12052',
    serviceVersion:'v12.0.7-policy-shadow-experiment',
    shadowPolicyEngineVersion:'v12.0.5.2-entry-exit-policy-shadow-review',
    candidateEngineVersion:'v12.0.5.1-forward-time-integrity-guard',
    snapshotId:'PS52-M4-MIGRATION',
    snapshotAt:'2026-08-03T22:00:00.000Z',
    experimentEpochAt:epoch,
    policyHash,
    inputFingerprint:{ test:true },
    baseClustersObserved:2,
    armScores:[{ experimentArmId:'E0_X0', scoredClusters:1 }],
    comparisons:[{ comparisonId:'E0_VS_E1_X0', pairedResolvedClusters:1 }],
    diagnostics:{ controlParity:[], sourceDivergence:[] },
    controlParityStatus:'PASS',
    temporalIntegrity:{ status:'PASS', violations:0 },
    paperOnly:true,
    executionEnabled:false,
    liveCapitalExecution:false,
    promotionEnabled:false,
  };

  const priorState = {
    ...engine.emptyState(),
    experimentEpochAt:epoch,
    policyHash,
    manifestSha256:manifest.manifestSha256,
    lastSnapshotId:snapshot.snapshotId,
    lastSnapshotAt:snapshot.snapshotAt,
    latestSnapshot:snapshot,
  };

  await fsp.writeFile(
    path.join(stateDir, 'entry-exit-policy-shadow-v12052.json'),
    JSON.stringify(priorState, null, 2),
  );

  await fsp.writeFile(
    path.join(evidenceDir, 'entry-exit-policy-shadow-manifest-v12052.ndjson'),
    `${JSON.stringify(manifest)}\n`,
  );

  await fsp.writeFile(
    path.join(evidenceDir, 'entry-exit-policy-shadow-snapshots-v12052.ndjson'),
    `${JSON.stringify(snapshot)}\n`,
  );

  await engine.init();

  const snapshotLines = (
    await fsp.readFile(
      path.join(
        evidenceDir,
        'entry-exit-policy-shadow-snapshots-v12052.ndjson',
      ),
      'utf8',
    )
  ).trim().split('\n');

  assert.strictEqual(snapshotLines.length, 1);
  assert.strictEqual(
    JSON.parse(snapshotLines[0]).snapshotId,
    snapshot.snapshotId,
  );

  const persisted = JSON.parse(
    await fsp.readFile(
      path.join(stateDir, 'entry-exit-policy-shadow-v12052.json'),
      'utf8',
    ),
  );

  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(persisted, 'latestSnapshot'),
    false,
  );
  assert.strictEqual(
    persisted.latestSnapshotRef.snapshotId,
    snapshot.snapshotId,
  );

  assert.deepStrictEqual(
    engine.armsView().arms,
    snapshot.armScores,
  );
  assert.deepStrictEqual(
    engine.comparisonsView().comparisons,
    snapshot.comparisons,
  );
  assert.deepStrictEqual(
    engine.diagnosticsView().diagnostics,
    snapshot.diagnostics,
  );

  const auditFile = path.join(
    evidenceDir,
    'entry-exit-policy-shadow-v12052.ndjson',
  );
  const auditLines = (
    await fsp.readFile(auditFile, 'utf8')
  ).trim().split('\n').filter(Boolean);

  assert.strictEqual(auditLines.length, 1);
  assert.strictEqual(
    JSON.parse(auditLines[0]).type,
    'POLICY_LATEST_SNAPSHOT_STATE_MIGRATED',
  );

  await fsp.rm(root, { recursive:true, force:true });
}

function testStaticSafetyAndVersion() {
  const persistence = fs.readFileSync('v1202-bundle.js', 'utf8');
  const policy = fs.readFileSync('policy-shadow-v12052.js', 'utf8');
  const bootstrap = fs.readFileSync(
    'policy-shadow-bootstrap-v120733.js',
    'utf8',
  );

  assert(persistence.includes('enqueueSerializedJson(file, serialized'));
  assert(persistence.includes('enqueueAppendSerialized(file, lines'));
  assert(
    persistence.includes(
      '{ serialized:job.serialized === true }',
    ),
  );

  assert(policy.includes('latestSnapshotRef:null'));
  assert(policy.includes('this.latestSnapshotCache=snapshot'));
  assert(policy.includes('enqueueSerializedJson('));
  assert(policy.includes('enqueueAppendSerialized('));
  assert.strictEqual(
    policy.includes('this.state.latestSnapshot=snapshot'),
    false,
  );
  assert.strictEqual(
    policy.includes('latestSnapshot:null'),
    false,
  );

  assert(
    bootstrap.includes(
      "v12.0.7.3.3-m4-bounded-persistence-snapshot",
    ),
  );

  const active = [
    persistence,
    policy,
    bootstrap,
    fs.readFileSync('policy-shadow-integrity-v120733.js', 'utf8'),
  ].join('\n');

  assert.strictEqual(
    /require\(\s*['"]worker_threads['"]\s*\)/.test(active),
    false,
  );
  assert.strictEqual(
    /new\s+Worker\s*\(/.test(active),
    false,
  );

  for (const expected of [
    'paperOnly:true',
    'executionEnabled:false',
    'liveCapitalExecution:false',
    'promotionEnabled:false',
    'v11Writes:0',
  ]) {
    assert(
      policy.includes(expected),
      `Missing frozen safety boundary: ${expected}`,
    );
  }
}

(async () => {
  testStaticSafetyAndVersion();
  await testSerializedQueueUnder256Mb();
  await testAtomicFailureSafety();
  await testLegacyMigrationAndViewParity();

  console.log(
    'v12.0.7.3.3-m4 bounded persistence snapshot tests passed',
  );
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
