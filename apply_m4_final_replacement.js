#!/usr/bin/env node
'use strict';

/*
 * ALPS v12.0.7.3.3-m4 final replacement helper
 *
 * This file updates only:
 *   - policy-shadow-v12052.js
 *   - test-v120733-m4.js
 *
 * It creates backups before writing and does not commit, push, merge, or deploy.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.cwd();
const POLICY = path.join(ROOT, 'policy-shadow-v12052.js');
const TEST = path.join(ROOT, 'test-v120733-m4.js');

function fail(message) {
  console.error(`\nSTOP: ${message}\n`);
  process.exit(1);
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  let quote = null;
  let templateDepth = 0;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;

  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (quote === '`') {
        if (ch === '$' && next === '{') {
          templateDepth += 1;
          depth += 1;
          i += 1;
          continue;
        }
        if (ch === '}' && templateDepth > 0) {
          templateDepth -= 1;
          depth -= 1;
          continue;
        }
      }
      if (ch === quote && templateDepth === 0) quote = null;
      continue;
    }

    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('Matching closing brace was not found');
}

function replaceMethod(text, header, replacement) {
  const start = text.indexOf(header);
  if (start < 0) {
    throw new Error(`Method header not found: ${header}`);
  }
  const brace = text.indexOf('{', start + header.length - 1);
  if (brace < 0) {
    throw new Error(`Opening brace not found: ${header}`);
  }
  const end = findMatchingBrace(text, brace);
  return text.slice(0, start) + replacement + text.slice(end);
}

function replaceRange(text, startMarker, endMarker, replacement) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      `Replacement range not found: ${startMarker} -> ${endMarker}`,
    );
  }
  return text.slice(0, start) + replacement + text.slice(end);
}

const migrationMethods = String.raw`  latestSnapshotReference(snapshot){
    if(!snapshot||typeof snapshot!=='object')return null;
    return{
      snapshotId:snapshot.snapshotId||null,
      recordedAt:snapshot.snapshotAt||snapshot.recordedAt||null,
      baseClustersObserved:Number(snapshot.baseClustersObserved||0),
      armScoreCount:Array.isArray(snapshot.armScores)?snapshot.armScores.length:0,
      comparisonCount:Array.isArray(snapshot.comparisons)?snapshot.comparisons.length:0,
      diagnosticSectionCount:snapshot.diagnostics&&typeof snapshot.diagnostics==='object'
        ?Object.keys(snapshot.diagnostics).length:0,
    };
  }
  snapshotTimeMs(snapshot){
    if(!snapshot||typeof snapshot!=='object')return null;
    return parseMs(snapshot.snapshotAt||snapshot.recordedAt||null);
  }
  async findSnapshotByIdStreaming(snapshotId){
    if(!snapshotId)return null;
    let found=null;
    try{
      const input=fs.createReadStream(this.files.snapshots,{encoding:'utf8'});
      const rl=readline.createInterface({input,crlfDelay:Infinity});
      for await(const line of rl){
        if(!line.trim())continue;
        let row;
        try{row=JSON.parse(line);}catch(_){continue;}
        if(row&&row.snapshotId===snapshotId)found=row;
      }
    }catch(error){
      if(error&&error.code==='ENOENT')return null;
      throw error;
    }
    return found;
  }
  async migrationAuditExists(migrationKey){
    if(!migrationKey)return false;
    try{
      const input=fs.createReadStream(this.files.ledger,{encoding:'utf8'});
      const rl=readline.createInterface({input,crlfDelay:Infinity});
      for await(const line of rl){
        if(!line.trim())continue;
        let row;
        try{row=JSON.parse(line);}catch(_){continue;}
        if(
          row&&
          row.type==='POLICY_LATEST_SNAPSHOT_STATE_MIGRATED'&&
          row.migrationKey===migrationKey
        )return true;
      }
    }catch(error){
      if(error&&error.code==='ENOENT')return false;
      throw error;
    }
    return false;
  }
  applyAuthoritativeSnapshot(snapshot){
    this.latestSnapshotCache=
      snapshot&&typeof snapshot==='object'?snapshot:null;
    this.state.latestSnapshotRef=
      this.latestSnapshotReference(this.latestSnapshotCache);

    if(!this.latestSnapshotCache)return;
    const selected=this.latestSnapshotCache;
    this.state.lastSnapshotId=
      selected.snapshotId||this.state.lastSnapshotId||null;
    this.state.lastSnapshotAt=
      selected.snapshotAt||
      selected.recordedAt||
      this.state.lastSnapshotAt||
      null;
    if(selected.inputFingerprint&&typeof selected.inputFingerprint==='object'){
      this.state.lastInputFingerprint=selected.inputFingerprint;
      if(Number.isFinite(Number(selected.inputFingerprint.certifiedEventCount))){
        this.state.processedSourceEvents=
          Number(selected.inputFingerprint.certifiedEventCount);
      }
    }
    if(Number.isFinite(Number(selected.baseClustersObserved))){
      this.state.baseClustersObserved=
        Number(selected.baseClustersObserved);
    }
    if(selected.controlParityStatus){
      this.state.controlParityStatus=selected.controlParityStatus;
    }
    if(selected.temporalIntegrity&&typeof selected.temporalIntegrity==='object'){
      this.state.temporalIntegrity=selected.temporalIntegrity;
    }
  }
  async writeMigrationAudit({
    classification,
    legacySnapshot,
    durableSnapshot,
    authoritativeSnapshot,
    snapshotAppended,
    duplicateSnapshotAppendAvoided,
  }){
    const migrationKey=stableHash({
      schema:'alps.gen2.policyShadowSnapshotMigrationKey.v120733m4',
      classification,
      legacySnapshotId:legacySnapshot?.snapshotId||null,
      legacySnapshotAt:
        legacySnapshot?.snapshotAt||legacySnapshot?.recordedAt||null,
      durableSnapshotId:durableSnapshot?.snapshotId||null,
      durableSnapshotAt:
        durableSnapshot?.snapshotAt||durableSnapshot?.recordedAt||null,
      authoritativeSnapshotId:authoritativeSnapshot?.snapshotId||null,
      authoritativeSnapshotAt:
        authoritativeSnapshot?.snapshotAt||
        authoritativeSnapshot?.recordedAt||
        null,
    });

    if(await this.migrationAuditExists(migrationKey))return false;

    const audit={
      schema:EVENT_SCHEMA,
      serviceVersion:SERVICE_VERSION,
      shadowPolicyEngineVersion:SHADOW_VERSION,
      type:'POLICY_LATEST_SNAPSHOT_STATE_MIGRATED',
      migrationKey,
      migrationClassification:classification,
      legacySnapshotId:legacySnapshot?.snapshotId||null,
      legacySnapshotAt:
        legacySnapshot?.snapshotAt||legacySnapshot?.recordedAt||null,
      durableSnapshotId:durableSnapshot?.snapshotId||null,
      durableSnapshotAt:
        durableSnapshot?.snapshotAt||durableSnapshot?.recordedAt||null,
      authoritativeSnapshotId:authoritativeSnapshot?.snapshotId||null,
      authoritativeSnapshotAt:
        authoritativeSnapshot?.snapshotAt||
        authoritativeSnapshot?.recordedAt||
        null,
      snapshotAppended:snapshotAppended===true,
      duplicateSnapshotAppendAvoided:
        duplicateSnapshotAppendAvoided===true,
      durableStateMode:'LATEST_SNAPSHOT_REF_ONLY',
      policyHash:this.state.policyHash||null,
      experimentEpochAt:this.state.experimentEpochAt||null,
      observedAt:iso(this.now()),
      paperOnly:true,
      executionEnabled:false,
      liveCapitalExecution:false,
      promotionEnabled:false,
    };
    const {done}=this.persistQueue.enqueueAppend(
      this.files.ledger,
      audit,
      {durable:true},
    );
    const result=await done;
    if(!result?.ok){
      throw new Error(
        \`POLICY_SNAPSHOT_MIGRATION_AUDIT_FAILED:\${result?.error||'unknown'}\`
      );
    }
    return true;
  }
  async appendLegacySnapshot(snapshot){
    const serialized=JSON.stringify(snapshot);
    const {done}=this.persistQueue.enqueueAppendSerialized(
      this.files.snapshots,
      serialized,
      {durable:true},
    );
    const result=await done;
    if(!result?.ok){
      throw new Error(
        \`POLICY_SNAPSHOT_MIGRATION_PERSIST_FAILED:\${result?.error||'unknown'}\`
      );
    }
  }
  async loadLatestSnapshotCache(legacySnapshot=null){
    const tail=await this.storage
      .readNdjsonTail(this.files.snapshots,1,32*1024*1024)
      .catch(()=>[]);
    const durableLatest=
      Array.isArray(tail)&&tail.length?tail.at(-1):null;

    if(!legacySnapshot||typeof legacySnapshot!=='object'){
      this.applyAuthoritativeSnapshot(durableLatest);
      return{
        classification:'NO_LEGACY_SNAPSHOT',
        authoritativeSnapshot:durableLatest,
        snapshotAppended:false,
      };
    }

    const legacyId=legacySnapshot.snapshotId||null;
    let authoritativeSnapshot=durableLatest;
    let classification='INVALID_LEGACY_SNAPSHOT_IGNORED';
    let snapshotAppended=false;
    let duplicateSnapshotAppendAvoided=false;

    if(!legacyId){
      classification=durableLatest
        ?'INVALID_LEGACY_SNAPSHOT_IGNORED'
        :'INVALID_LEGACY_SNAPSHOT_NO_DURABLE_BASELINE';
    }else if(!durableLatest){
      const durableCopy=await this.findSnapshotByIdStreaming(legacyId);
      if(durableCopy){
        authoritativeSnapshot=durableCopy;
        classification='LEGACY_SNAPSHOT_ALREADY_DURABLE';
        duplicateSnapshotAppendAvoided=true;
      }else{
        await this.appendLegacySnapshot(legacySnapshot);
        authoritativeSnapshot=legacySnapshot;
        classification='LEGACY_SNAPSHOT_APPENDED_NO_DURABLE_BASELINE';
        snapshotAppended=true;
      }
    }else if(durableLatest.snapshotId===legacyId){
      authoritativeSnapshot=durableLatest;
      classification='LEGACY_SNAPSHOT_ALREADY_DURABLE';
      duplicateSnapshotAppendAvoided=true;
    }else{
      const legacyMs=this.snapshotTimeMs(legacySnapshot);
      const durableMs=this.snapshotTimeMs(durableLatest);

      if(!Number.isFinite(legacyMs)||!Number.isFinite(durableMs)){
        authoritativeSnapshot=durableLatest;
        classification='AMBIGUOUS_LEGACY_SNAPSHOT_IGNORED';
      }else if(legacyMs<durableMs){
        authoritativeSnapshot=durableLatest;
        classification='STALE_LEGACY_SNAPSHOT_IGNORED';
      }else if(legacyMs===durableMs){
        authoritativeSnapshot=durableLatest;
        classification='EQUAL_TIMESTAMP_LEGACY_SNAPSHOT_IGNORED';
      }else{
        const durableCopy=await this.findSnapshotByIdStreaming(legacyId);
        if(durableCopy){
          authoritativeSnapshot=durableCopy;
          classification='NEWER_LEGACY_SNAPSHOT_ALREADY_DURABLE';
          duplicateSnapshotAppendAvoided=true;
        }else{
          await this.appendLegacySnapshot(legacySnapshot);
          authoritativeSnapshot=legacySnapshot;
          classification='NEWER_LEGACY_SNAPSHOT_APPENDED';
          snapshotAppended=true;
        }
      }
    }

    this.applyAuthoritativeSnapshot(authoritativeSnapshot);
    await this.writeMigrationAudit({
      classification,
      legacySnapshot,
      durableSnapshot:durableLatest,
      authoritativeSnapshot,
      snapshotAppended,
      duplicateSnapshotAppendAvoided,
    });

    return{
      classification,
      authoritativeSnapshot,
      snapshotAppended,
      duplicateSnapshotAppendAvoided,
    };
  }
`;

const initMethod = String.raw`  async init(){
    const prior=await this.storage.readJson(this.files.state,null);
    const legacySnapshot=
      prior&&prior.schema===STATE_SCHEMA
        ?prior.latestSnapshot||null
        :null;
    this.state={
      ...this.emptyState(),
      ...(prior&&prior.schema===STATE_SCHEMA?prior:{}),
    };
    delete this.state.latestSnapshot;

    const manifests=await this.storage.readNdjson(this.files.manifest);
    let manifest=
      manifests.find(x=>x&&x.schema===MANIFEST_SCHEMA)||null;

    if(!manifest){
      const epoch=this.state.experimentEpochAt||this.startupAt;
      const body=this.policyBody(
        epoch,
        this.scoringViewProvider?.()||null,
      );
      const policyHash=stableHash(body);
      manifest={
        schema:MANIFEST_SCHEMA,
        manifestVersion:'v1.1',
        ...body,
        policyHash,
        manifestSha256:stableHash({...body,policyHash}),
        status:'FROZEN_FOR_IMPLEMENTATION',
        createdFromSourceEventAt:null,
      };
      const {done}=this.persistQueue.enqueueAppend(
        this.files.manifest,
        manifest,
        {durable:true},
      );
      const result=await done;
      if(!result?.ok){
        throw new Error(
          \`POLICY_MANIFEST_PERSIST_FAILED:\${result?.error||'unknown'}\`
        );
      }
    }else{
      const expected=this.policyBody(
        manifest.experimentEpochAt,
        {
          lastSnapshotId:manifest.timeStopSourceSnapshotId||null,
          lastSnapshotAt:
            manifest.timeStopSourceDistributionDate||null,
        },
      );
      const computed=stableHash(expected);
      if(computed!==manifest.policyHash){
        this.state.status='POLICY_HASH_MISMATCH_BLOCKED';
        this.state.lastError=
          'EXISTING_MANIFEST_POLICY_HASH_DIFFERS_FROM_FROZEN_V1_1_IMPLEMENTATION';
        await this.persistState();
        return this.view();
      }
    }

    this.manifest=manifest;
    this.state.experimentEpochAt=manifest.experimentEpochAt;
    this.state.policyHash=manifest.policyHash;
    this.state.manifestSha256=manifest.manifestSha256;

    await this.loadLatestSnapshotCache(legacySnapshot);

    this.state.status='POLICY_SHADOW_EXPERIMENT_READY';
    this.ready=true;
    await this.persistState();
    return this.view();
  }`;

const testFile = "'use strict';\n\nconst assert = require('assert');\nconst fs = require('fs');\nconst fsp = fs.promises;\nconst os = require('os');\nconst path = require('path');\n\nconst {\n  SafeStorage,\n  PersistenceQueue,\n} = require('./v1202-bundle');\n\nconst {\n  PolicyShadowEngine,\n  stableHash,\n} = require('./policy-shadow-v12052');\n\nfunction delay(ms) {\n  return new Promise(resolve => setTimeout(resolve, ms));\n}\n\nfunction makeSnapshot(id, snapshotAt, marker) {\n  return {\n    schema:'alps.gen2.entryExitPolicyShadowSnapshot.v12052',\n    serviceVersion:'v12.0.7-policy-shadow-experiment',\n    shadowPolicyEngineVersion:'v12.0.5.2-entry-exit-policy-shadow-review',\n    candidateEngineVersion:'v12.0.5.1-forward-time-integrity-guard',\n    snapshotId:id,\n    snapshotAt,\n    experimentEpochAt:'2026-07-24T18:01:37.185Z',\n    policyHash:null,\n    inputFingerprint:{\n      marker,\n      certifiedEventCount:marker === 'A' ? 10 : marker === 'B' ? 20 : 30,\n    },\n    baseClustersObserved:marker === 'A' ? 1 : marker === 'B' ? 2 : 3,\n    armScores:[{\n      scopeType:'GLOBAL',\n      scopeId:'GLOBAL',\n      experimentArmId:'E0_X0',\n      marker,\n      baseClustersObserved:marker === 'A' ? 1 : marker === 'B' ? 2 : 3,\n    }],\n    comparisons:[{ comparisonId:'E0_VS_E1_X0', marker }],\n    diagnostics:{ marker, controlParity:[], sourceDivergence:[] },\n    controlParityStatus:'PASS',\n    temporalIntegrity:{ status:'PASS', violations:0 },\n    paperOnly:true,\n    executionEnabled:false,\n    liveCapitalExecution:false,\n    promotionEnabled:false,\n  };\n}\n\nasync function readJsonLines(file) {\n  try {\n    return (await fsp.readFile(file, 'utf8'))\n      .split('\\n')\n      .filter(Boolean)\n      .map(JSON.parse);\n  } catch (_) {\n    return [];\n  }\n}\n\nasync function createFixture({\n  legacySnapshot = null,\n  durableSnapshots = [],\n  tamperManifest = false,\n  stateOverrides = {},\n} = {}) {\n  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'alps-m4-integrity-'));\n  const evidenceDir = path.join(root, 'evidence');\n  const stateDir = path.join(root, 'state');\n  const cleanDir = path.join(root, 'crypto', 'clean');\n\n  await Promise.all([\n    fsp.mkdir(evidenceDir, { recursive:true }),\n    fsp.mkdir(stateDir, { recursive:true }),\n    fsp.mkdir(cleanDir, { recursive:true }),\n  ]);\n\n  const config = {\n    dataRoot:root,\n    legacyRoot:path.join(root, 'legacy'),\n    crypto:{\n      cleanDir,\n      certifiedCandidateLedgerFile:path.join(\n        evidenceDir,\n        'crypto-forward-shadow-ledger-v12051.ndjson',\n      ),\n      candidateLedgerFile:path.join(\n        evidenceDir,\n        'crypto-forward-shadow-ledger-v12051.ndjson',\n      ),\n    },\n  };\n\n  const storage = new SafeStorage(config);\n  const queue = new PersistenceQueue({\n    storage,\n    retryDelayMs:5,\n    maxRetryDelayMs:20,\n  });\n  const now = () => Date.parse('2026-08-04T06:00:00.000Z');\n\n  const engine = new PolicyShadowEngine({\n    config,\n    storage,\n    persistQueue:queue,\n    now,\n    startupAt:'2026-08-04T06:00:00.000Z',\n    controlViewProvider:() => null,\n    scoringViewProvider:() => null,\n  });\n\n  const epoch = '2026-07-24T18:01:37.185Z';\n  const body = engine.policyBody(epoch, null);\n  const policyHash = stableHash(body);\n  const manifest = {\n    schema:'alps.gen2.entryExitPolicyShadowManifest.v12052',\n    manifestVersion:'v1.1',\n    ...body,\n    policyHash:tamperManifest ? 'tampered-policy-hash' : policyHash,\n    manifestSha256:stableHash({ ...body, policyHash }),\n    status:'FROZEN_FOR_IMPLEMENTATION',\n    createdFromSourceEventAt:null,\n  };\n\n  for (const snapshot of durableSnapshots) {\n    snapshot.policyHash = policyHash;\n  }\n  if (legacySnapshot) legacySnapshot.policyHash = policyHash;\n\n  const state = {\n    ...engine.emptyState(),\n    experimentEpochAt:epoch,\n    policyHash,\n    manifestSha256:manifest.manifestSha256,\n    lastSnapshotId:legacySnapshot?.snapshotId || durableSnapshots.at(-1)?.snapshotId || null,\n    lastSnapshotAt:legacySnapshot?.snapshotAt || durableSnapshots.at(-1)?.snapshotAt || null,\n    ...(legacySnapshot ? { latestSnapshot:legacySnapshot } : {}),\n    ...stateOverrides,\n  };\n\n  const files = {\n    state:path.join(stateDir, 'entry-exit-policy-shadow-v12052.json'),\n    manifest:path.join(\n      evidenceDir,\n      'entry-exit-policy-shadow-manifest-v12052.ndjson',\n    ),\n    snapshots:path.join(\n      evidenceDir,\n      'entry-exit-policy-shadow-snapshots-v12052.ndjson',\n    ),\n    ledger:path.join(\n      evidenceDir,\n      'entry-exit-policy-shadow-v12052.ndjson',\n    ),\n  };\n\n  await fsp.writeFile(files.state, JSON.stringify(state, null, 2));\n  await fsp.writeFile(files.manifest, `${JSON.stringify(manifest)}\\n`);\n  await fsp.writeFile(\n    files.snapshots,\n    durableSnapshots.map(JSON.stringify).join('\\n') +\n      (durableSnapshots.length ? '\\n' : ''),\n  );\n\n  return {\n    root,\n    config,\n    storage,\n    queue,\n    engine,\n    files,\n    policyHash,\n  };\n}\n\nasync function destroyFixture(fixture) {\n  await fsp.rm(fixture.root, { recursive:true, force:true });\n}\n\nfunction assertViews(engine, snapshot) {\n  assert.strictEqual(engine.view().lastSnapshotId, snapshot.snapshotId);\n  assert.strictEqual(engine.view().lastSnapshotAt, snapshot.snapshotAt);\n  assert.deepStrictEqual(engine.armsView().arms, snapshot.armScores);\n  assert.deepStrictEqual(\n    engine.comparisonsView().comparisons,\n    snapshot.comparisons,\n  );\n  assert.deepStrictEqual(\n    engine.diagnosticsView().diagnostics,\n    snapshot.diagnostics,\n  );\n}\n\nasync function testSerializedQueueUnder256Mb() {\n  let active = 0;\n  let maxActive = 0;\n  let physicalWrites = 0;\n  let finalPayload = null;\n  const optionRows = [];\n\n  const storage = {\n    async writeJsonAtomic(file, payload, options = {}) {\n      active += 1;\n      maxActive = Math.max(maxActive, active);\n      physicalWrites += 1;\n      optionRows.push(options);\n      await delay(4);\n      finalPayload = String(payload);\n      active -= 1;\n    },\n  };\n\n  const queue = new PersistenceQueue({\n    storage,\n    retryDelayMs:5,\n    maxRetryDelayMs:20,\n  });\n\n  const originalStructuredClone = global.structuredClone;\n  global.structuredClone = () => {\n    throw new Error('STRUCTURED_CLONE_MUST_NOT_RUN_ON_SERIALIZED_PATH');\n  };\n\n  const before = process.memoryUsage().heapUsed;\n  const sharedBlob = 'x'.repeat(1024 * 1024);\n  const waits = [];\n\n  try {\n    for (let index = 0; index < 55; index += 1) {\n      const serialized = JSON.stringify({\n        index,\n        sharedBlob,\n        paperOnly:true,\n        executionEnabled:false,\n        liveCapitalExecution:false,\n        promotionEnabled:false,\n      });\n      waits.push(\n        queue.enqueueSerializedJson(\n          '/virtual/policy-state.json',\n          serialized,\n          { durable:true },\n        ).done,\n      );\n    }\n    const results = await Promise.all(waits);\n    assert(results.every(result => result?.ok === true));\n  } finally {\n    global.structuredClone = originalStructuredClone;\n  }\n\n  if (global.gc) {\n    global.gc();\n    await delay(10);\n    global.gc();\n  }\n\n  const growthMb = (\n    process.memoryUsage().heapUsed - before\n  ) / 1048576;\n\n  assert.strictEqual(maxActive, 1);\n  assert(physicalWrites >= 1);\n  assert(physicalWrites < 55);\n  assert(optionRows.every(row => row.serialized === true));\n  assert.strictEqual(JSON.parse(finalPayload).index, 54);\n  assert(\n    growthMb < 96,\n    `Expected bounded heap growth below 96MB, observed ${growthMb.toFixed(2)}MB`,\n  );\n}\n\nasync function testAtomicFailureSafety() {\n  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'alps-m4-atomic-'));\n  const storage = new SafeStorage({\n    dataRoot:root,\n    legacyRoot:path.join(root, 'legacy'),\n  });\n  const file = path.join(root, 'state', 'policy.json');\n\n  await storage.writeJsonAtomic(\n    file,\n    '{\"revision\":1}',\n    { serialized:true },\n  );\n\n  const originalRename = fs.promises.rename;\n  fs.promises.rename = async () => {\n    throw new Error('FORCED_RENAME_FAILURE');\n  };\n\n  try {\n    await assert.rejects(\n      storage.writeJsonAtomic(\n        file,\n        '{\"revision\":2}',\n        { serialized:true },\n      ),\n      /FORCED_RENAME_FAILURE/,\n    );\n  } finally {\n    fs.promises.rename = originalRename;\n  }\n\n  assert.deepStrictEqual(\n    JSON.parse(await fsp.readFile(file, 'utf8')),\n    { revision:1 },\n  );\n  const files = await fsp.readdir(path.dirname(file));\n  assert.strictEqual(files.some(name => name.endsWith('.tmp')), false);\n  await fsp.rm(root, { recursive:true, force:true });\n}\n\nasync function testOlderLegacyCannotReplaceNewerDurable() {\n  const A = makeSnapshot(\n    'PS52-A',\n    '2026-08-04T01:00:00.000Z',\n    'A',\n  );\n  const B = makeSnapshot(\n    'PS52-B',\n    '2026-08-04T02:00:00.000Z',\n    'B',\n  );\n  const fixture = await createFixture({\n    legacySnapshot:A,\n    durableSnapshots:[B],\n  });\n\n  try {\n    await fixture.engine.init();\n    const rows = await readJsonLines(fixture.files.snapshots);\n    assert.deepStrictEqual(rows.map(row => row.snapshotId), ['PS52-B']);\n    assertViews(fixture.engine, B);\n\n    const audits = await readJsonLines(fixture.files.ledger);\n    assert.strictEqual(audits.length, 1);\n    assert.strictEqual(\n      audits[0].migrationClassification,\n      'STALE_LEGACY_SNAPSHOT_IGNORED',\n    );\n    assert.strictEqual(audits[0].snapshotAppended, false);\n  } finally {\n    await destroyFixture(fixture);\n  }\n}\n\nasync function testEarlierDuplicateIsNotAppended() {\n  const A = makeSnapshot(\n    'PS52-A',\n    '2026-08-04T01:00:00.000Z',\n    'A',\n  );\n  const B = makeSnapshot(\n    'PS52-B',\n    '2026-08-04T02:00:00.000Z',\n    'B',\n  );\n  const fixture = await createFixture({\n    legacySnapshot:A,\n    durableSnapshots:[A, B],\n  });\n\n  try {\n    await fixture.engine.init();\n    const rows = await readJsonLines(fixture.files.snapshots);\n    assert.deepStrictEqual(\n      rows.map(row => row.snapshotId),\n      ['PS52-A', 'PS52-B'],\n    );\n    assertViews(fixture.engine, B);\n  } finally {\n    await destroyFixture(fixture);\n  }\n}\n\nasync function testSameSnapshotIdIsNotAppended() {\n  const A = makeSnapshot(\n    'PS52-A',\n    '2026-08-04T01:00:00.000Z',\n    'A',\n  );\n  const fixture = await createFixture({\n    legacySnapshot:{ ...A },\n    durableSnapshots:[A],\n  });\n\n  try {\n    await fixture.engine.init();\n    const rows = await readJsonLines(fixture.files.snapshots);\n    assert.strictEqual(rows.length, 1);\n    assertViews(fixture.engine, A);\n\n    const audits = await readJsonLines(fixture.files.ledger);\n    assert.strictEqual(\n      audits[0].migrationClassification,\n      'LEGACY_SNAPSHOT_ALREADY_DURABLE',\n    );\n  } finally {\n    await destroyFixture(fixture);\n  }\n}\n\nasync function testAmbiguousTimestampPrefersDurable() {\n  const A = makeSnapshot('PS52-A', null, 'A');\n  const B = makeSnapshot(\n    'PS52-B',\n    '2026-08-04T02:00:00.000Z',\n    'B',\n  );\n  const fixture = await createFixture({\n    legacySnapshot:A,\n    durableSnapshots:[B],\n  });\n\n  try {\n    await fixture.engine.init();\n    const rows = await readJsonLines(fixture.files.snapshots);\n    assert.deepStrictEqual(rows.map(row => row.snapshotId), ['PS52-B']);\n    assertViews(fixture.engine, B);\n\n    const audits = await readJsonLines(fixture.files.ledger);\n    assert.strictEqual(\n      audits[0].migrationClassification,\n      'AMBIGUOUS_LEGACY_SNAPSHOT_IGNORED',\n    );\n  } finally {\n    await destroyFixture(fixture);\n  }\n}\n\nasync function testManifestMismatchPerformsNoMigrationWrites() {\n  const C = makeSnapshot(\n    'PS52-C',\n    '2026-08-04T03:00:00.000Z',\n    'C',\n  );\n  const fixture = await createFixture({\n    legacySnapshot:C,\n    durableSnapshots:[],\n    tamperManifest:true,\n  });\n\n  try {\n    const beforeSnapshots = await fsp.readFile(\n      fixture.files.snapshots,\n      'utf8',\n    );\n    await fixture.engine.init();\n    const afterSnapshots = await fsp.readFile(\n      fixture.files.snapshots,\n      'utf8',\n    );\n\n    assert.strictEqual(\n      fixture.engine.view().status,\n      'POLICY_HASH_MISMATCH_BLOCKED',\n    );\n    assert.strictEqual(beforeSnapshots, afterSnapshots);\n    assert.deepStrictEqual(\n      await readJsonLines(fixture.files.ledger),\n      [],\n    );\n  } finally {\n    await destroyFixture(fixture);\n  }\n}\n\nasync function testNewerLegacyAppendsOnceAndRestartIsIdempotent() {\n  const A = makeSnapshot(\n    'PS52-A',\n    '2026-08-04T01:00:00.000Z',\n    'A',\n  );\n  const C = makeSnapshot(\n    'PS52-C',\n    '2026-08-04T03:00:00.000Z',\n    'C',\n  );\n  const fixture = await createFixture({\n    legacySnapshot:C,\n    durableSnapshots:[A],\n  });\n\n  try {\n    await fixture.engine.init();\n\n    let rows = await readJsonLines(fixture.files.snapshots);\n    let audits = await readJsonLines(fixture.files.ledger);\n    assert.deepStrictEqual(\n      rows.map(row => row.snapshotId),\n      ['PS52-A', 'PS52-C'],\n    );\n    assert.strictEqual(audits.length, 1);\n    assert.strictEqual(\n      audits[0].migrationClassification,\n      'NEWER_LEGACY_SNAPSHOT_APPENDED',\n    );\n    assert.strictEqual(audits[0].snapshotAppended, true);\n    assertViews(fixture.engine, C);\n\n    const persisted = JSON.parse(\n      await fsp.readFile(fixture.files.state, 'utf8'),\n    );\n    assert.strictEqual(\n      Object.prototype.hasOwnProperty.call(\n        persisted,\n        'latestSnapshot',\n      ),\n      false,\n    );\n    assert.strictEqual(\n      persisted.latestSnapshotRef.snapshotId,\n      'PS52-C',\n    );\n\n    const restart = new PolicyShadowEngine({\n      config:fixture.config,\n      storage:fixture.storage,\n      persistQueue:new PersistenceQueue({\n        storage:fixture.storage,\n        retryDelayMs:5,\n        maxRetryDelayMs:20,\n      }),\n      now:() => Date.parse('2026-08-04T06:05:00.000Z'),\n      startupAt:'2026-08-04T06:05:00.000Z',\n      controlViewProvider:() => null,\n      scoringViewProvider:() => null,\n    });\n\n    await restart.init();\n    rows = await readJsonLines(fixture.files.snapshots);\n    audits = await readJsonLines(fixture.files.ledger);\n\n    assert.deepStrictEqual(\n      rows.map(row => row.snapshotId),\n      ['PS52-A', 'PS52-C'],\n    );\n    assert.strictEqual(audits.length, 1);\n    assertViews(restart, C);\n  } finally {\n    await destroyFixture(fixture);\n  }\n}\n\nasync function testNewerLegacyAlreadyEarlierUsesDurableCopy() {\n  const B = makeSnapshot(\n    'PS52-B',\n    '2026-08-04T02:00:00.000Z',\n    'B',\n  );\n  const C = makeSnapshot(\n    'PS52-C',\n    '2026-08-04T03:00:00.000Z',\n    'C',\n  );\n  const fixture = await createFixture({\n    legacySnapshot:{ ...C },\n    durableSnapshots:[C, B],\n  });\n\n  try {\n    await fixture.engine.init();\n    const rows = await readJsonLines(fixture.files.snapshots);\n    assert.deepStrictEqual(\n      rows.map(row => row.snapshotId),\n      ['PS52-C', 'PS52-B'],\n    );\n    assertViews(fixture.engine, C);\n\n    const audits = await readJsonLines(fixture.files.ledger);\n    assert.strictEqual(\n      audits[0].migrationClassification,\n      'NEWER_LEGACY_SNAPSHOT_ALREADY_DURABLE',\n    );\n    assert.strictEqual(audits[0].snapshotAppended, false);\n  } finally {\n    await destroyFixture(fixture);\n  }\n}\n\nfunction testStaticSafetyAndVersion() {\n  const persistence = fs.readFileSync('v1202-bundle.js', 'utf8');\n  const policy = fs.readFileSync('policy-shadow-v12052.js', 'utf8');\n  const bootstrap = fs.readFileSync(\n    'policy-shadow-bootstrap-v120733.js',\n    'utf8',\n  );\n\n  assert(persistence.includes('enqueueSerializedJson(file, serialized'));\n  assert(persistence.includes('enqueueAppendSerialized(file, lines'));\n  assert(policy.includes('latestSnapshotRef:null'));\n  assert(policy.includes('findSnapshotByIdStreaming'));\n  assert(policy.includes('migrationAuditExists'));\n  assert(policy.includes('STALE_LEGACY_SNAPSHOT_IGNORED'));\n  assert.strictEqual(\n    policy.includes('this.state.latestSnapshot=snapshot'),\n    false,\n  );\n  assert(\n    bootstrap.includes(\n      'v12.0.7.3.3-m4-bounded-persistence-snapshot',\n    ),\n  );\n\n  const active = [\n    persistence,\n    policy,\n    bootstrap,\n    fs.readFileSync('policy-shadow-integrity-v120733.js', 'utf8'),\n  ].join('\\n');\n\n  assert.strictEqual(\n    /require\\(\\s*['\"]worker_threads['\"]\\s*\\)/.test(active),\n    false,\n  );\n  assert.strictEqual(/new\\s+Worker\\s*\\(/.test(active), false);\n\n  for (const expected of [\n    'paperOnly:true',\n    'executionEnabled:false',\n    'liveCapitalExecution:false',\n    'promotionEnabled:false',\n    'v11Writes:0',\n  ]) {\n    assert(\n      policy.includes(expected),\n      `Missing frozen safety boundary: ${expected}`,\n    );\n  }\n}\n\n(async () => {\n  testStaticSafetyAndVersion();\n  await testSerializedQueueUnder256Mb();\n  await testAtomicFailureSafety();\n  await testOlderLegacyCannotReplaceNewerDurable();\n  await testEarlierDuplicateIsNotAppended();\n  await testSameSnapshotIdIsNotAppended();\n  await testAmbiguousTimestampPrefersDurable();\n  await testManifestMismatchPerformsNoMigrationWrites();\n  await testNewerLegacyAppendsOnceAndRestartIsIdempotent();\n  await testNewerLegacyAlreadyEarlierUsesDurableCopy();\n\n  console.log(\n    'v12.0.7.3.3-m4 migration-integrity regression tests passed',\n  );\n})().catch(error => {\n  console.error(error);\n  process.exitCode = 1;\n});\n";

function ensurePackageAndDocker() {
  const packageFile = path.join(ROOT, 'package.json');
  if (fs.existsSync(packageFile)) {
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const commands = {
      check:'node --check test-v120733-m4.js',
      test:'node test-v120733-m4.js',
      'test:memory':
        'node --max-old-space-size=256 --expose-gc test-v120733-m4.js',
    };
    for (const [name, command] of Object.entries(commands)) {
      if (!pkg.scripts?.[name]) {
        fail(`package.json is missing scripts.${name}`);
      }
      if (!pkg.scripts[name].includes(command)) {
        pkg.scripts[name] += ` && ${command}`;
      }
    }
    fs.writeFileSync(
      packageFile,
      `${JSON.stringify(pkg, null, 2)}\n`,
      'utf8',
    );
  }

  const dockerFile = path.join(ROOT, 'Dockerfile');
  if (fs.existsSync(dockerFile)) {
    let docker = fs.readFileSync(dockerFile, 'utf8');
    if (!docker.includes('test-v120733-m4.js')) {
      const marker = '  test-v120733-heap-retry.js \\\n';
      if (!docker.includes(marker)) {
        fail('Dockerfile insertion marker was not found');
      }
      docker = docker.replace(
        marker,
        `${marker}  test-v120733-m4.js \\\n`,
      );
      fs.writeFileSync(dockerFile, docker, 'utf8');
    }
  }
}

function run(command, args) {
  console.log(`\n=== ${command} ${args.join(' ')} ===`);
  const result = spawnSync(command, args, {
    cwd:ROOT,
    stdio:'inherit',
    env:process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${command} exited with status ${result.status}`);
  }
}

function main() {
  if (!fs.existsSync(POLICY)) {
    fail('policy-shadow-v12052.js was not found in the current folder');
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-');
  const backupDir = path.join(
    ROOT,
    `.m4-replacement-backup-${timestamp}`,
  );
  fs.mkdirSync(backupDir, { recursive:true });
  fs.copyFileSync(
    POLICY,
    path.join(backupDir, 'policy-shadow-v12052.js'),
  );
  if (fs.existsSync(TEST)) {
    fs.copyFileSync(
      TEST,
      path.join(backupDir, 'test-v120733-m4.js'),
    );
  }

  let policy = fs.readFileSync(POLICY, 'utf8');
  policy = replaceRange(
    policy,
    '  latestSnapshotReference(snapshot){',
    '  policyBody(epoch,scoring){',
    migrationMethods,
  );
  policy = replaceMethod(
    policy,
    '  async init(){',
    initMethod,
  );

  for (const required of [
    'findSnapshotByIdStreaming',
    'migrationAuditExists',
    'STALE_LEGACY_SNAPSHOT_IGNORED',
    'NEWER_LEGACY_SNAPSHOT_APPENDED',
    "this.state.status='POLICY_HASH_MISMATCH_BLOCKED'",
  ]) {
    if (!policy.includes(required)) {
      fail(`Generated policy file is missing: ${required}`);
    }
  }

  fs.writeFileSync(POLICY, policy, 'utf8');
  fs.writeFileSync(TEST, testFile, 'utf8');
  ensurePackageAndDocker();

  console.log(`\nBackup created at:\n${backupDir}`);
  console.log('\nReplacement files written successfully.');

  run('node', ['--check', 'policy-shadow-v12052.js']);
  run('node', ['--check', 'test-v120733-m4.js']);
  run('node', ['--expose-gc', 'test-v120733-m4.js']);
  run('npm', ['run', 'validate']);
  run('npm', ['run', 'test:memory']);
  run('docker', [
    'build',
    '--progress=plain',
    '-t',
    'alps-server-runner:m4',
    '.',
  ]);

  console.log('\n=== REPLACEMENT COMPLETE ===');
  console.log('All validation and Docker gates passed.');
  console.log('No commit, push, merge, or deployment was performed.');
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error);
  process.exit(1);
}
