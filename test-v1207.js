'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const {
  PolicyShadowEngine,
  stableHash,
  deriveSetupAtSignal,
  simulateExit,
  riskGeometry,
} = require('./policy-shadow-v12052');

class TestStorage {
  constructor(config){this.config=config;}
  assertV12Write(file){const r=path.resolve(file),root=path.resolve(this.config.dataRoot)+path.sep;if(!r.startsWith(root))throw new Error('WRITE_OUTSIDE_V12_ROOT_BLOCKED');if(r.startsWith(path.resolve(this.config.legacyRoot)+path.sep))throw new Error('V11_WRITE_BLOCKED');}
  async readJson(file,fallback=null){try{return JSON.parse(await fsp.readFile(file,'utf8'));}catch(_){return fallback;}}
  async writeJsonAtomic(file,payload,{serialized=false}={}){this.assertV12Write(file);await fsp.mkdir(path.dirname(file),{recursive:true});const text=serialized===true?String(payload):JSON.stringify(payload,null,2);await fsp.writeFile(file,text,'utf8');}
  async readNdjson(file){try{return(await fsp.readFile(file,'utf8')).split('\n').filter(Boolean).map(JSON.parse);}catch(_){return[];}}
  async appendNdjsonLines(file,lines){this.assertV12Write(file);await fsp.mkdir(path.dirname(file),{recursive:true});const a=(Array.isArray(lines)?lines:[lines]).map(x=>typeof x==='string'?x:JSON.stringify(x));await fsp.appendFile(file,a.join('\n')+'\n');}
  async readNdjsonTail(file,limit=50){const a=await this.readNdjson(file);return a.slice(-limit);}
  async readCrypto(dir,symbol,frame){return this.readNdjson(path.join(dir,symbol,`${frame}.ndjson`));}
}
class TestQueue {
  constructor(storage){this.storage=storage;this.files=new Map();this.appendFiles=new Map();}
  entry(file){let e=this.files.get(file);if(!e){e={revision:0,committedRevision:0,pending:null,writing:false,writesStarted:0,writesCommitted:0,writesFailed:0,writesCoalesced:0,lastError:null,lastCommittedAt:null,retries:0};this.files.set(file,e);}return e;}
  appendEntry(file){let e=this.appendFiles.get(file);if(!e){e={revision:0,committedRevision:0,queue:[],writing:false,writesStarted:0,writesCommitted:0,writesFailed:0,lastError:null,lastCommittedAt:null,retries:0};this.appendFiles.set(file,e);}return e;}
  enqueue(file,state){const e=this.entry(file);e.revision++;e.writing=true;e.writesStarted++;const revision=e.revision;const done=this.storage.writeJsonAtomic(file,structuredClone(state)).then(()=>{e.committedRevision=revision;e.writesCommitted++;e.lastCommittedAt=new Date().toISOString();e.writing=false;return{ok:true,committedRevision:revision};}).catch(err=>{e.writesFailed++;e.lastError=String(err.message);e.writing=false;return{ok:false,error:e.lastError};});return{revision,done};}
  enqueueSerializedJson(file,serialized){const e=this.entry(file);e.revision++;e.writing=true;e.writesStarted++;const revision=e.revision;const done=this.storage.writeJsonAtomic(file,String(serialized),{serialized:true}).then(()=>{e.committedRevision=revision;e.writesCommitted++;e.lastCommittedAt=new Date().toISOString();e.writing=false;return{ok:true,committedRevision:revision};}).catch(err=>{e.writesFailed++;e.lastError=String(err.message);e.writing=false;return{ok:false,error:e.lastError};});return{revision,done};}
  enqueueAppendSerialized(file,lines){const normalized=(Array.isArray(lines)?lines:[lines]).map(String);return this.enqueueAppend(file,normalized);}
  enqueueAppend(file,lines){const e=this.appendEntry(file);e.revision++;e.writing=true;e.writesStarted++;const revision=e.revision;const done=this.storage.appendNdjsonLines(file,lines).then(()=>{e.committedRevision=revision;e.writesCommitted++;e.lastCommittedAt=new Date().toISOString();e.writing=false;return{ok:true,committedRevision:revision};}).catch(err=>{e.writesFailed++;e.lastError=String(err.message);e.writing=false;return{ok:false,error:e.lastError};});return{revision,done};}
  view(file){const e=this.files.get(file);return e?{revision:e.revision,committedRevision:e.committedRevision,pendingRevision:null,pendingDurable:false,writing:e.writing,lastError:e.lastError,lastCommittedAt:e.lastCommittedAt,writesStarted:e.writesStarted,writesCommitted:e.writesCommitted,writesFailed:e.writesFailed,writesCoalesced:e.writesCoalesced,retries:e.retries}:{revision:0,committedRevision:0,pendingRevision:null,pendingDurable:false,writing:false};}
  viewAppend(file){const e=this.appendFiles.get(file);return e?{revision:e.revision,committedRevision:e.committedRevision,pendingRevisions:[],writing:e.writing,lastError:e.lastError,lastCommittedAt:e.lastCommittedAt,writesStarted:e.writesStarted,writesCommitted:e.writesCommitted,writesFailed:e.writesFailed,retries:e.retries}:{revision:0,committedRevision:0,pendingRevisions:[],writing:false};}
  async flush(){return{ok:true,flushed:true};}
}

function candles(start,count,interval){const rows=[];let close=100;for(let i=0;i<count;i++){const t=start+i*interval;const next=close+1;rows.push({t,o:close,h:next+0.2,l:close-0.2,c:next,v:1000,closeTime:t+interval-1,validForSignals:true});close=next;}return rows;}

(async()=>{
  // Risk geometry guard.
  assert.strictEqual(riskGeometry({entry:100,stop:99.8,direction:'LONG',atrValue:1}).valid,false);
  assert.strictEqual(riskGeometry({entry:100,stop:99.7,direction:'LONG',atrValue:1}).valid,true);

  // Time stop uses candle close and target has priority.
  const interval=300000,base=Date.UTC(2026,6,24,16,0,0),exitRows=[
    {t:base,o:100,h:100.2,l:99.8,c:100,closeTime:base+interval-1},
    {t:base+interval,o:100,h:100.5,l:99.7,c:100.25,closeTime:base+2*interval-1},
    {t:base+2*interval,o:100.25,h:100.6,l:99.9,c:100.4,closeTime:base+3*interval-1},
  ];
  const timed=simulateExit({candles:exitRows,entryIndex:0,entry:100,stop:99,direction:'LONG',targets:[{rr:1,target:110},{rr:2,target:120},{rr:5,target:150}],exitPolicy:{timeStops:{R1:2,R2:2,R5:2}}});
  assert.strictEqual(timed.R1.status,'TIME_STOP_EXIT');
  assert.strictEqual(timed.R1.resultR,0.4);
  const targetFirst=simulateExit({candles:[exitRows[0],{...exitRows[1],h:101.2,c:100.2}],entryIndex:0,entry:100,stop:99,direction:'LONG',targets:[{rr:1,target:101},{rr:2,target:120},{rr:5,target:150}],exitPolicy:{timeStops:{R1:1,R2:1,R5:1}}});
  assert.strictEqual(targetFirst.R1.status,'TARGET_HIT');

  // End-to-end frozen experiment: E0 expires, E1 enters first candle, E2 enters second.
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'alps-v1207-'));
  const config={dataRoot:path.join(root,'v12'),legacyRoot:path.join(root,'v11'),crypto:{cleanDir:path.join(root,'v12','crypto','clean'),certifiedCandidateLedgerFile:path.join(root,'v12','evidence','crypto-forward-shadow-ledger-v12051.ndjson'),candidateLedgerFile:path.join(root,'v12','evidence','crypto-forward-shadow-ledger-v12051.ndjson')}};
  const storage=new TestStorage(config);const queue=new TestQueue(storage);
  await fsp.mkdir(path.dirname(config.crypto.certifiedCandidateLedgerFile),{recursive:true});
  const rows=candles(base-70*interval,70,interval);const signalIndex=69,signal=rows[signalIndex];
  const setup=deriveSetupAtSignal({family:'TREND_CONTINUATION',candles:rows,symbolKey:'BTCUSDT',symbol:'BTC/USDT',timeframe:'5m',intervalMs:interval,epochMs:Date.UTC(2026,6,24,8,0,0)});
  assert.strictEqual(setup.produced,true);
  const nominatedAt=iso(signal.closeTime+1000),candidateId=`FS51-BTCUSDT-5m-TREND_CONTINUATION-${signal.t}-LONG`,clusterId=`EC51|BTCUSDT|5m|${signal.t}|LONG|${setup.entry}|${setup.initialStop}`;
  const firstT=signal.t+interval; // opens before nomination; deliberately ineligible
  const secondT=firstT+interval,firstEligibleClose=setup.entry+setup.features.atr*0.30; // outside E0, inside E1
  const thirdT=secondT+interval,secondEligibleClose=setup.entry+setup.features.atr*0.05; // inside E0 for E2
  const fourthT=thirdT+interval;
  rows.push({t:firstT,o:setup.entry,h:setup.entry+0.1,l:setup.entry-0.1,c:setup.entry,v:1000,closeTime:firstT+interval-1,validForSignals:true});
  rows.push({t:secondT,o:setup.entry,h:Math.max(setup.entry,firstEligibleClose)+0.1,l:Math.min(setup.entry,firstEligibleClose)-0.1,c:firstEligibleClose,v:1000,closeTime:secondT+interval-1,validForSignals:true});
  rows.push({t:thirdT,o:firstEligibleClose,h:Math.max(firstEligibleClose,secondEligibleClose)+0.1,l:Math.min(firstEligibleClose,secondEligibleClose)-0.1,c:secondEligibleClose,v:1000,closeTime:thirdT+interval-1,validForSignals:true});
  rows.push({t:fourthT,o:secondEligibleClose,h:Math.max(firstEligibleClose+(firstEligibleClose-setup.initialStop)+0.2,secondEligibleClose+(secondEligibleClose-setup.initialStop)+0.2,secondEligibleClose+0.2),l:secondEligibleClose-0.1,c:secondEligibleClose+0.2,v:1000,closeTime:fourthT+interval-1,validForSignals:true});
  const cleanFile=path.join(config.crypto.cleanDir,'BTCUSDT','5m.ndjson');await fsp.mkdir(path.dirname(cleanFile),{recursive:true});await fsp.writeFile(cleanFile,rows.map(JSON.stringify).join('\n')+'\n');
  const nomination={schema:'alps.gen2.cryptoForwardShadowLedgerEvent.v12051',version:'v12.0.5.1-forward-time-integrity-guard',sequence:1,eventId:'FS51-E0000000001',type:'CANDIDATE_NOMINATED',evidenceClass:'CERTIFIED_FORWARD_V12051',candidateEngineEpochAt:'2026-07-24T10:10:00.513Z',candidateId,hypothesisId:'CRYPTO-BTCUSDT-5m-TREND_CONTINUATION',evidenceClusterId:clusterId,symbol:'BTC/USDT',timeframe:'5m',family:'TREND_CONTINUATION',direction:'LONG',signalCandleOpenAt:iso(signal.t),signalCandleCloseAt:iso(signal.closeTime),nominatedAt,entryZoneLow:setup.entryZoneLow,entryZoneHigh:setup.entryZoneHigh,plannedInitialStop:setup.initialStop,setupId:setup.signature,observedAt:nominatedAt,at:nominatedAt,paperOnly:true,liveCapitalExecution:false};
  const expiry={...nomination,sequence:2,eventId:'FS51-E0000000002',type:'CANDIDATE_ENTRY_EXPIRED',reason:'ENTRY_ZONE_EXPIRED_BEFORE_FORWARD_ENTRY',candleOpenAt:iso(secondT),candleCloseAt:iso(secondT+interval-1),observedClose:firstEligibleClose,observedAt:iso(secondT+interval+1000),at:iso(secondT+interval+1000)};
  const preEpoch={...nomination,sequence:0,eventId:'FS51-E0000000000',candidateId:`PRE-${candidateId}`,evidenceClusterId:`PRE-${clusterId}`,nominatedAt:iso(parseMs(nominatedAt)-5000),observedAt:iso(parseMs(nominatedAt)-5000),at:iso(parseMs(nominatedAt)-5000)};
  await fsp.writeFile(config.crypto.certifiedCandidateLedgerFile,[preEpoch,nomination,expiry].map(JSON.stringify).join('\n')+'\n');
  const controlView={candidateEngineEpochAt:'2026-07-24T10:10:00.513Z',lastEvaluatedAt:iso(fourthT+interval-1),lastLedgerEventAt:expiry.observedAt,pendingCandidateCount:0,openCandidateCount:0,performance:{},temporalIntegrity:{status:'PASS',violations:0,lastViolationAt:null,lastViolation:null}};
  const engine=new PolicyShadowEngine({config,storage,persistQueue:queue,startupAt:iso(parseMs(nominatedAt)-1000),controlViewProvider:()=>controlView,scoringViewProvider:()=>({lastSnapshotId:'ES6-test',lastSnapshotAt:iso(base)})});
  await engine.init();await engine.run('test');
  const arms=engine.armsView().arms.filter(x=>x.scopeType==='GLOBAL');
  const e0=arms.find(x=>x.experimentArmId==='E0_X0'),e1=arms.find(x=>x.experimentArmId==='E1_X0'),e2=arms.find(x=>x.experimentArmId==='E2_X0');
  assert.strictEqual(e0.expiredClusters,1);
  assert.strictEqual(e1.enteredClusters,1);
  assert.strictEqual(e2.enteredClusters,1);
  assert.strictEqual(engine.view().controlParityStatus,'PASS');
  assert.strictEqual(engine.view().temporalIntegrity.status,'PASS');
  assert.strictEqual(engine.view().baseClustersObserved,1); // pre-experiment nomination excluded
  const cmp=engine.comparisonsView().comparisons.find(x=>x.scopeType==='GLOBAL'&&x.comparisonId==='E0_VS_E1_X0'&&x.leg==='R1');
  assert.strictEqual(cmp.pairedClusterCount,1);
  assert.strictEqual(cmp.meanPairedOpportunityRDelta,1);
  assert.ok(cmp.reviewBlockers.includes('PAIRED_RESOLVED_CLUSTERS_BELOW_60'));
  const fakeArm={experimentArmId:'E0_X1',entryModelVersion:'E0_CONTROL_CURRENT_ZONE_ONE_CANDLE',exitPolicyVersion:'X1_TIME_STOP_24_48_96',entryStatus:'ENTERED',resolved:true,entered:true,expired:false,invalidRiskDistance:false,entryRiskDistanceATR:1,entryDelayBars:1,memberHypothesisIds:['CRYPTO-BTCUSDT-5m-TREND_CONTINUATION'],legs:{R1:{status:'OPEN',holdingBars:25},R2:{status:'OPEN',holdingBars:10},R5:{status:'OPEN',holdingBars:10}}};
  const fakeScores=engine.armStatistics([{sourceStatus:'PASS',baseEvidenceClusterId:'FAKE-OPEN-TAIL',memberHypothesisIds:fakeArm.memberHypothesisIds,arms:{E0_X1:fakeArm}}]);
  const fakeGlobal=fakeScores.find(x=>x.scopeType==='GLOBAL'&&x.experimentArmId==='E0_X1');
  assert.strictEqual(fakeGlobal.legs.R1.openBeyondTimeStopCount,1);
  const firstSnapshot=engine.view().lastSnapshotId;await engine.run('determinism');assert.strictEqual(engine.view().lastSnapshotId,firstSnapshot);
  const stuck=queue.entry(engine.files.state);stuck.writing=true;stuck.writesStarted=stuck.writesCommitted+stuck.writesFailed;
  assert.strictEqual(engine.view().persistence.state.writing,false);
  assert.ok(engine.view().persistenceInvariantRepairs>=1);
  assert.strictEqual(engine.manifestView().knownUntestedInteractions[0].id,'WIDE_ZONE_X_EXTENDED_WINDOW');
  assert.strictEqual(engine.manifestView().multipleTestingAdjusted,false);
  assert.ok(engine.view().lastInputFingerprint.ledgerSha256);
  assert.ok(engine.view().lastInputFingerprint.candleWitnessManifestSha256);
  const policyEvents=await storage.readNdjson(engine.files.ledger);
  const e1Event=policyEvents.find(x=>x.type==='POLICY_ARM_STATE_CHANGED'&&x.experimentArmId==='E1_X0');
  assert.ok(e1Event&&e1Event.arm.entered);
  assert.strictEqual(e1Event.arm.targets[0].target,Number((e1Event.arm.entry+e1Event.arm.riskDistance).toPrecision(12)));
  // Existing epoch + different policy hash is blocked rather than silently reinterpreted.
  const manifestRows=await storage.readNdjson(engine.files.manifest);
  manifestRows[0].policyHash='tampered-policy-hash';
  await fsp.writeFile(engine.files.manifest,manifestRows.map(JSON.stringify).join('\n')+'\n');
  const blocked=new PolicyShadowEngine({config,storage,persistQueue:new TestQueue(storage),startupAt:iso(parseMs(nominatedAt)+100000),controlViewProvider:()=>controlView,scoringViewProvider:()=>({lastSnapshotId:'ES6-test',lastSnapshotAt:iso(base)})});
  await blocked.init();
  assert.strictEqual(blocked.view().status,'POLICY_HASH_MISMATCH_BLOCKED');
  console.log('v12.0.7 policy shadow tests: PASS');
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});

function iso(value){return new Date(value).toISOString();}
function parseMs(value){return Date.parse(value);}
