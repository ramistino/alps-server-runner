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

function makeSnapshot(id, snapshotAt, marker) {
  return {
    schema:'alps.gen2.entryExitPolicyShadowSnapshot.v12052',
    serviceVersion:'v12.0.7-policy-shadow-experiment',
    shadowPolicyEngineVersion:'v12.0.5.2-entry-exit-policy-shadow-review',
    candidateEngineVersion:'v12.0.5.1-forward-time-integrity-guard',
    snapshotId:id,
    snapshotAt,
    experimentEpochAt:'2026-07-24T18:01:37.185Z',
    policyHash:null,
    inputFingerprint:{
      marker,
      certifiedEventCount:marker === 'A' ? 10 : marker === 'B' ? 20 : 30,
    },
    baseClustersObserved:marker === 'A' ? 1 : marker === 'B' ? 2 : 3,
    armScores:[{
      scopeType:'GLOBAL',
      scopeId:'GLOBAL',
      experimentArmId:'E0_X0',
      marker,
      baseClustersObserved:marker === 'A' ? 1 : marker === 'B' ? 2 : 3,
    }],
    comparisons:[{ comparisonId:'E0_VS_E1_X0', marker }],
    diagnostics:{ marker, controlParity:[], sourceDivergence:[] },
    controlParityStatus:'PASS',
    temporalIntegrity:{ status:'PASS', violations:0 },
    paperOnly:true,
    executionEnabled:false,
    liveCapitalExecution:false,
    promotionEnabled:false,
  };
}

async function readJsonLines(file) {
  try {
    return (await fsp.readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
  } catch (_) {
    return [];
  }
}

async function createFixture({
  legacySnapshot = null,
  durableSnapshots = [],
  tamperManifest = false,
  stateOverrides = {},
} = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'alps-m4-integrity-'));
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
  const now = () => Date.parse('2026-08-04T06:00:00.000Z');

  const engine = new PolicyShadowEngine({
    config,
    storage,
    persistQueue:queue,
    now,
    startupAt:'2026-08-04T06:00:00.000Z',
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
    policyHash:tamperManifest ? 'tampered-policy-hash' : policyHash,
    manifestSha256:stableHash({ ...body, policyHash }),
    status:'FROZEN_FOR_IMPLEMENTATION',
    createdFromSourceEventAt:null,
  };

  for (const snapshot of durableSnapshots) {
    snapshot.policyHash = policyHash;
  }
  if (legacySnapshot) legacySnapshot.policyHash = policyHash;

  const state = {
    ...engine.emptyState(),
    experimentEpochAt:epoch,
    policyHash,
    manifestSha256:manifest.manifestSha256,
    lastSnapshotId:legacySnapshot?.snapshotId || durableSnapshots.at(-1)?.snapshotId || null,
    lastSnapshotAt:legacySnapshot?.snapshotAt || durableSnapshots.at(-1)?.snapshotAt || null,
    ...(legacySnapshot ? { latestSnapshot:legacySnapshot } : {}),
    ...stateOverrides,
  };

  const files = {
    state:path.join(stateDir, 'entry-exit-policy-shadow-v12052.json'),
    manifest:path.join(
      evidenceDir,
      'entry-exit-policy-shadow-manifest-v12052.ndjson',
    ),
    snapshots:path.join(
      evidenceDir,
      'entry-exit-policy-shadow-snapshots-v12052.ndjson',
    ),
    ledger:path.join(
      evidenceDir,
      'entry-exit-policy-shadow-v12052.ndjson',
    ),
  };

  await fsp.writeFile(files.state, JSON.stringify(state, null, 2));
  await fsp.writeFile(files.manifest, `${JSON.stringify(manifest)}\n`);
  await fsp.writeFile(
    files.snapshots,
    durableSnapshots.map(JSON.stringify).join('\n') +
      (durableSnapshots.length ? '\n' : ''),
  );

  return {
    root,
    config,
    storage,
    queue,
    engine,
    files,
    policyHash,
  };
}

async function destroyFixture(fixture) {
  await fsp.rm(fixture.root, { recursive:true, force:true });
}

function assertViews(engine, snapshot) {
  assert.strictEqual(engine.view().lastSnapshotId, snapshot.snapshotId);
  assert.strictEqual(engine.view().lastSnapshotAt, snapshot.snapshotAt);
  assert.deepStrictEqual(engine.armsView().arms, snapshot.armScores);
  assert.deepStrictEqual(
    engine.comparisonsView().comparisons,
    snapshot.comparisons,
  );
  assert.deepStrictEqual(
    engine.diagnosticsView().diagnostics,
    snapshot.diagnostics,
  );
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
    assert(results.every(result => result?.ok === true));
  } finally {
    global.structuredClone = originalStructuredClone;
  }

  if (global.gc) {
    global.gc();
    await delay(10);
    global.gc();
  }

  const growthMb = (
    process.memoryUsage().heapUsed - before
  ) / 1048576;

  assert.strictEqual(maxActive, 1);
  assert(physicalWrites >= 1);
  assert(physicalWrites < 55);
  assert(optionRows.every(row => row.serialized === true));
  assert.strictEqual(JSON.parse(finalPayload).index, 54);
  assert(
    growthMb < 96,
    `Expected bounded heap growth below 96MB, observed ${growthMb.toFixed(2)}MB`,
  );
}

async function testAtomicFailureSafety() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'alps-m4-atomic-'));
  const storage = new SafeStorage({
    dataRoot:root,
    legacyRoot:path.join(root, 'legacy'),
  });
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
  assert.strictEqual(files.some(name => name.endsWith('.tmp')), false);
  await fsp.rm(root, { recursive:true, force:true });
}

async function testOlderLegacyCannotReplaceNewerDurable() {
  const A = makeSnapshot(
    'PS52-A',
    '2026-08-04T01:00:00.000Z',
    'A',
  );
  const B = makeSnapshot(
    'PS52-B',
    '2026-08-04T02:00:00.000Z',
    'B',
  );
  const fixture = await createFixture({
    legacySnapshot:A,
    durableSnapshots:[B],
  });

  try {
    await fixture.engine.init();
    const rows = await readJsonLines(fixture.files.snapshots);
    assert.deepStrictEqual(rows.map(row => row.snapshotId), ['PS52-B']);
    assertViews(fixture.engine, B);

    const audits = await readJsonLines(fixture.files.ledger);
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(
      audits[0].migrationClassification,
      'STALE_LEGACY_SNAPSHOT_IGNORED',
    );
    assert.strictEqual(audits[0].snapshotAppended, false);
  } finally {
    await destroyFixture(fixture);
  }
}

async function testEarlierDuplicateIsNotAppended() {
  const A = makeSnapshot(
    'PS52-A',
    '2026-08-04T01:00:00.000Z',
    'A',
  );
  const B = makeSnapshot(
    'PS52-B',
    '2026-08-04T02:00:00.000Z',
    'B',
  );
  const fixture = await createFixture({
    legacySnapshot:A,
    durableSnapshots:[A, B],
  });

  try {
    await fixture.engine.init();
    const rows = await readJsonLines(fixture.files.snapshots);
    assert.deepStrictEqual(
      rows.map(row => row.snapshotId),
      ['PS52-A', 'PS52-B'],
    );
    assertViews(fixture.engine, B);
  } finally {
    await destroyFixture(fixture);
  }
}

async function testSameSnapshotIdIsNotAppended() {
  const A = makeSnapshot(
    'PS52-A',
    '2026-08-04T01:00:00.000Z',
    'A',
  );
  const fixture = await createFixture({
    legacySnapshot:{ ...A },
    durableSnapshots:[A],
  });

  try {
    await fixture.engine.init();
    const rows = await readJsonLines(fixture.files.snapshots);
    assert.strictEqual(rows.length, 1);
    assertViews(fixture.engine, A);

    const audits = await readJsonLines(fixture.files.ledger);
    assert.strictEqual(
      audits[0].migrationClassification,
      'LEGACY_SNAPSHOT_ALREADY_DURABLE',
    );
  } finally {
    await destroyFixture(fixture);
  }
}

async function testAmbiguousTimestampPrefersDurable() {
  const A = makeSnapshot('PS52-A', null, 'A');
  const B = makeSnapshot(
    'PS52-B',
    '2026-08-04T02:00:00.000Z',
    'B',
  );
  const fixture = await createFixture({
    legacySnapshot:A,
    durableSnapshots:[B],
  });

  try {
    await fixture.engine.init();
    const rows = await readJsonLines(fixture.files.snapshots);
    assert.deepStrictEqual(rows.map(row => row.snapshotId), ['PS52-B']);
    assertViews(fixture.engine, B);

    const audits = await readJsonLines(fixture.files.ledger);
    assert.strictEqual(
      audits[0].migrationClassification,
      'AMBIGUOUS_LEGACY_SNAPSHOT_IGNORED',
    );
  } finally {
    await destroyFixture(fixture);
  }
}

async function testManifestMismatchPerformsNoMigrationWrites() {
  const C = makeSnapshot(
    'PS52-C',
    '2026-08-04T03:00:00.000Z',
    'C',
  );
  const fixture = await createFixture({
    legacySnapshot:C,
    durableSnapshots:[],
    tamperManifest:true,
  });

  try {
    const beforeSnapshots = await fsp.readFile(
      fixture.files.snapshots,
      'utf8',
    );
    await fixture.engine.init();
    const afterSnapshots = await fsp.readFile(
      fixture.files.snapshots,
      'utf8',
    );

    assert.strictEqual(
      fixture.engine.view().status,
      'POLICY_HASH_MISMATCH_BLOCKED',
    );
    assert.strictEqual(beforeSnapshots, afterSnapshots);
    assert.deepStrictEqual(
      await readJsonLines(fixture.files.ledger),
      [],
    );
  } finally {
    await destroyFixture(fixture);
  }
}

async function testNewerLegacyAppendsOnceAndRestartIsIdempotent() {
  const A = makeSnapshot(
    'PS52-A',
    '2026-08-04T01:00:00.000Z',
    'A',
  );
  const C = makeSnapshot(
    'PS52-C',
    '2026-08-04T03:00:00.000Z',
    'C',
  );
  const fixture = await createFixture({
    legacySnapshot:C,
    durableSnapshots:[A],
  });

  try {
    await fixture.engine.init();

    let rows = await readJsonLines(fixture.files.snapshots);
    let audits = await readJsonLines(fixture.files.ledger);
    assert.deepStrictEqual(
      rows.map(row => row.snapshotId),
      ['PS52-A', 'PS52-C'],
    );
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(
      audits[0].migrationClassification,
      'NEWER_LEGACY_SNAPSHOT_APPENDED',
    );
    assert.strictEqual(audits[0].snapshotAppended, true);
    assertViews(fixture.engine, C);

    const persisted = JSON.parse(
      await fsp.readFile(fixture.files.state, 'utf8'),
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(
        persisted,
        'latestSnapshot',
      ),
      false,
    );
    assert.strictEqual(
      persisted.latestSnapshotRef.snapshotId,
      'PS52-C',
    );

    const restart = new PolicyShadowEngine({
      config:fixture.config,
      storage:fixture.storage,
      persistQueue:new PersistenceQueue({
        storage:fixture.storage,
        retryDelayMs:5,
        maxRetryDelayMs:20,
      }),
      now:() => Date.parse('2026-08-04T06:05:00.000Z'),
      startupAt:'2026-08-04T06:05:00.000Z',
      controlViewProvider:() => null,
      scoringViewProvider:() => null,
    });

    await restart.init();
    rows = await readJsonLines(fixture.files.snapshots);
    audits = await readJsonLines(fixture.files.ledger);

    assert.deepStrictEqual(
      rows.map(row => row.snapshotId),
      ['PS52-A', 'PS52-C'],
    );
    assert.strictEqual(audits.length, 1);
    assertViews(restart, C);
  } finally {
    await destroyFixture(fixture);
  }
}

async function testNewerLegacyAlreadyEarlierUsesDurableCopy() {
  const B = makeSnapshot(
    'PS52-B',
    '2026-08-04T02:00:00.000Z',
    'B',
  );
  const C = makeSnapshot(
    'PS52-C',
    '2026-08-04T03:00:00.000Z',
    'C',
  );
  const fixture = await createFixture({
    legacySnapshot:{ ...C },
    durableSnapshots:[C, B],
  });

  try {
    await fixture.engine.init();
    const rows = await readJsonLines(fixture.files.snapshots);
    assert.deepStrictEqual(
      rows.map(row => row.snapshotId),
      ['PS52-C', 'PS52-B'],
    );
    assertViews(fixture.engine, C);

    const audits = await readJsonLines(fixture.files.ledger);
    assert.strictEqual(
      audits[0].migrationClassification,
      'NEWER_LEGACY_SNAPSHOT_ALREADY_DURABLE',
    );
    assert.strictEqual(audits[0].snapshotAppended, false);
  } finally {
    await destroyFixture(fixture);
  }
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
  assert(policy.includes('latestSnapshotRef:null'));
  assert(policy.includes('findSnapshotByIdStreaming'));
  assert(policy.includes('migrationAuditExists'));
  assert(policy.includes('STALE_LEGACY_SNAPSHOT_IGNORED'));
  assert.strictEqual(
    policy.includes('this.state.latestSnapshot=snapshot'),
    false,
  );
  assert(
    bootstrap.includes(
      'v12.0.7.3.3-m4-bounded-persistence-snapshot',
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
  assert.strictEqual(/new\s+Worker\s*\(/.test(active), false);

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
  await testOlderLegacyCannotReplaceNewerDurable();
  await testEarlierDuplicateIsNotAppended();
  await testSameSnapshotIdIsNotAppended();
  await testAmbiguousTimestampPrefersDurable();
  await testManifestMismatchPerformsNoMigrationWrites();
  await testNewerLegacyAppendsOnceAndRestartIsIdempotent();
  await testNewerLegacyAlreadyEarlierUsesDurableCopy();

  console.log(
    'v12.0.7.3.3-m4 migration-integrity regression tests passed',
  );
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
