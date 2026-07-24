#!/usr/bin/env node
'use strict';

// v12.0.4.4.2 — memory-bounded startup/rebuild tests. Fully offline.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SafeStorage, MemoryTracker, ForexEngine, CryptoEngine, MultiMarketEngine,
  CRYPTO_FRAMES, VERSION,
} = require('./v1202-bundle');

const INTERVAL = 300000;
const NOW = Date.UTC(2026, 6, 24, 12, 0, 0, 0);
function makeCandles(count, start, base=100){
  const rows=[];let close=base;
  for(let i=0;i<count;i++){const t=start+i*INTERVAL;const delta=((i%17)-8)*0.00001;const open=close;close=Math.max(0.0001,open*(1+delta));rows.push({t,o:open,h:Math.max(open,close)*1.0002,l:Math.min(open,close)*0.9998,c:close,v:1,closeTime:t+INTERVAL-1});}
  return rows;
}
function config(root,{forexPairs=2,cryptoSymbols=2}={}){
  const dataRoot=path.join(root,'v12');
  const fxAll=[['EUR/USD','EURUSD'],['GBP/USD','GBPUSD'],['USD/JPY','USDJPY'],['USD/CHF','USDCHF'],['USD/CAD','USDCAD'],['AUD/USD','AUDUSD'],['NZD/USD','NZDUSD'],['EUR/JPY','EURJPY'],['GBP/JPY','GBPJPY']];
  const crAll=[['BTC/USDT','BTCUSDT'],['ETH/USDT','ETHUSDT'],['SOL/USDT','SOLUSDT'],['BNB/USDT','BNBUSDT'],['XRP/USDT','XRPUSDT'],['DOGE/USDT','DOGEUSDT'],['XAUT/USDT','XAUTUSDT']];
  return {
    dataRoot,legacyRoot:path.join(root,'v11'),paperOnly:true,legacyEngineEnabled:false,newsEnabled:false,
    forexEnabled:true,cryptoEnabled:true,importLegacyOnStartup:false,maxLegacyFiles:10,maxLegacyFileBytes:1024,
    forexPairs:fxAll.slice(0,forexPairs).map(([canonical,key])=>({canonical,key,provider:canonical})),
    cryptoSymbols:crAll.slice(0,cryptoSymbols).map(([canonical,key])=>({canonical,key,provider:key})),cryptoFrames:CRYPTO_FRAMES,
    forex:{apiKey:'',providerBaseUrl:'https://example.invalid',interval:'5min',intervalMs:INTERVAL,refreshIntervalMs:1800000,minLiveRequestGapMs:1500000,interSymbolDelayMs:0,requestTimeoutMs:100,leaseSafetyMarginMs:50,persistTimeoutMs:1000,watchdogIntervalMs:30000,backfillMaxRequestsPerCycle:0,backfillCycleYieldMarginMs:120000,staleMarketDataMs:5400000,candleCloseBufferMs:30000,backfillCoverageDays:180,backfillOutputSize:5000,liveOutputSize:500,hardDailyCredits:600,scheduledCreditCeiling:540,rawDir:path.join(dataRoot,'raw'),cleanDir:path.join(dataRoot,'clean'),stateFile:path.join(dataRoot,'state','forex-core-state.json'),budgetFile:path.join(dataRoot,'state','twelve-data-budget.json'),leaseFile:path.join(dataRoot,'state','twelve-data-request-lease.json'),migrationFile:path.join(dataRoot,'state','v11-readonly-import.json'),hypothesesFile:path.join(dataRoot,'hypotheses','forex-hypotheses.json')},
    crypto:{providerBaseUrl:'https://example.invalid',refreshIntervalMs:300000,minLiveRequestGapMs:240000,interRequestDelayMs:0,requestTimeoutMs:100,staleMultiplier:3.25,candleCloseBufferMs:15000,backfillCoverageDays:180,liveLimit:500,backfillLimit:1000,backfillRequestsPerRun:1,maxCandlesPerFrame:60000,rawDir:path.join(dataRoot,'crypto','raw'),cleanDir:path.join(dataRoot,'crypto','clean'),stateFile:path.join(dataRoot,'state','crypto-core-state.json'),providerStateFile:path.join(dataRoot,'state','binance-market-data-state.json'),migrationFile:path.join(dataRoot,'state','v11-crypto-readonly-import.json'),hypothesesFile:path.join(dataRoot,'hypotheses','crypto-hypotheses.json'),continuityFile:path.join(dataRoot,'reports','crypto-continuity-audit.json'),forwardShadowFile:path.join(dataRoot,'state','crypto-forward-shadow-foundation.json'),historicalEvidenceFile:path.join(dataRoot,'evidence','legacy-crypto-paper-evidence.json'),continuityMaxGapRanges:25,evidenceMaxFiles:10,evidenceMaxBytesPerFile:1024},
  };
}

(async()=>{
  const tests=[];const T=async(name,fn)=>{await fn();tests.push(name);};
  await T('version is v12.0.4.4.2',async()=>assert.equal(VERSION,'v12.0.6-evidence-statistical-scoring'));
  await T('memory tracker exposes required fields',async()=>{const m=new MemoryTracker();await m.checkpoint('TEST','EUR/USD','5m');const v=m.view();for(const key of ['rssMb','heapUsedMb','heapTotalMb','peakHeapUsedMb','memoryPhase','memoryPair','memoryFrame'])assert(Object.hasOwn(v,key),key);assert.equal(v.memoryPhase,'TEST');});
  await T('forex rebuild releases pair arrays and creates 55 hypotheses',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'alps-mem-fx-'));const c=config(root,{forexPairs:9,cryptoSymbols:0});const storage=new SafeStorage(c);await storage.init();const start=NOW-6000*INTERVAL;for(const pair of c.forexPairs)await storage.writeForex(c.forex.rawDir,pair,makeCandles(6000,start,1.1),{test:true});const memory=new MemoryTracker({now:()=>NOW});const engine=new ForexEngine({config:c,storage,now:()=>NOW,log:()=>{},memory});await engine.cleanAndRebuild('memory-test');assert.equal(engine.hypotheses.count,55);assert(engine.state.markets.EURUSD.cleanRows>4000);assert(memory.view().memoryPhase==='FOREX_REBUILD_COMPLETE');assert(memory.view().peakHeapUsedMb<240,`peak=${memory.view().peakHeapUsedMb}`);});
  await T('crypto rebuild processes frames sequentially and creates all hypotheses',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'alps-mem-cr-'));const c=config(root,{forexPairs:0,cryptoSymbols:2});const storage=new SafeStorage(c);await storage.init();const start=NOW-12000*INTERVAL;for(const symbol of c.cryptoSymbols)await storage.writeCrypto(c.crypto.rawDir,symbol.key,'5m',makeCandles(12000,start,100),{test:true});const memory=new MemoryTracker({now:()=>NOW});const engine=new CryptoEngine({config:c,storage,now:()=>NOW,log:()=>{},memory});engine.forwardShadow={schema:'alps.gen2.cryptoForwardShadowFoundation.v12043',version:VERSION,epochAt:new Date(start).toISOString(),mode:'OBSERVATION_ONLY',frames:{}};await engine.cleanAndRebuild('memory-test');assert.equal(engine.hypotheses.count,2*5*5);assert.equal(engine.continuity.pairFrames,10);assert.equal(engine.state.frames['BTCUSDT:15m'].source,'DERIVED_FROM_CANONICAL_5M_CLOSED');assert(memory.view().memoryPhase==='CRYPTO_REBUILD_COMPLETE');assert(memory.view().peakHeapUsedMb<240,`peak=${memory.view().peakHeapUsedMb}`);});
  await T('multimarket initialization source is sequential, not Promise.allSettled',async()=>{const source=fs.readFileSync(path.join(__dirname,'v1202-bundle.js'),'utf8');const block=source.slice(source.indexOf('class MultiMarketEngine'),source.indexOf('const DASHBOARD_HTML'));assert(!block.includes('Promise.allSettled(jobs)'));assert(block.indexOf('this.crypto.init()')<block.indexOf('this.forex.init()'));});
  await T('startup duplicate rebuilds removed',async()=>{const source=fs.readFileSync(path.join(__dirname,'v1202-bundle.js'),'utf8');const fx=source.slice(source.indexOf('class ForexEngine'),source.indexOf('class BinanceMarketDataProvider'));const cr=source.slice(source.indexOf('class CryptoEngine'),source.indexOf('class MultiMarketEngine'));assert(!fx.includes("await this.cleanAndRebuild('startup');"));assert(!cr.includes("await this.cleanAndRebuild('startup-canonicalize');"));});
  console.log(JSON.stringify({status:'PASS',version:VERSION,tests:tests.length,names:tests},null,2));
})().catch(e=>{console.error(e&&e.stack||e);process.exit(1);});
