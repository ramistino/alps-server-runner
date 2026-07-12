'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { canonicalPair, finite, iso, round, summarizeError, text, timestamp } = require('./utils');

const PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','XAUTUSDT'];
const TIMEFRAMES = ['5m','15m','30m','1h','4h'];
const TF_MS = { '5m':300000, '15m':900000, '30m':1800000, '1h':3600000, '4h':14400000 };
const BINANCE_ALIAS = { XAUTUSDT:'PAXGUSDT' };
const OKX_ALIAS = { XAUTUSDT:'PAXG-USDT' };
const BYBIT_ALIAS = { XAUTUSDT:'PAXGUSDT' };
const OKX_BAR = { '5m':'5m','15m':'15m','30m':'30m','1h':'1H','4h':'4H' };
const BYBIT_INTERVAL = { '5m':'5','15m':'15','30m':'30','1h':'60','4h':'240' };

function sma(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a,b)=>a+b,0)/period;
}
function ema(values, period) {
  if (!values.length) return null;
  const k=2/(period+1);
  let out=values[0];
  for (let i=1;i<values.length;i++) out=values[i]*k+out*(1-k);
  return out;
}
function atr(candles, period=14) {
  if (candles.length < period+1) return null;
  const tr=[];
  for (let i=1;i<candles.length;i++) {
    const c=candles[i], p=candles[i-1];
    tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));
  }
  return sma(tr,period);
}
function rsi(values, period=14) {
  if (values.length < period+1) return null;
  let gains=0, losses=0;
  const start=values.length-period;
  for (let i=start;i<values.length;i++) {
    const d=values[i]-values[i-1];
    if(d>0) gains+=d; else losses-=d;
  }
  if(losses===0) return gains>0?100:50;
  const rs=(gains/period)/(losses/period);
  return 100-(100/(1+rs));
}
function zscoreLast(values, period=20) {
  if(values.length<period) return null;
  const xs=values.slice(-period), mean=xs.reduce((a,b)=>a+b,0)/period;
  const variance=xs.reduce((a,b)=>a+(b-mean)**2,0)/period;
  const sd=Math.sqrt(variance);
  return sd>0?(xs[xs.length-1]-mean)/sd:0;
}
function normalizeCandle(row) {
  if (!Array.isArray(row) || row.length < 6) return null;
  const out={ openTime:Number(row[0]), open:Number(row[1]), high:Number(row[2]), low:Number(row[3]), close:Number(row[4]), volume:Number(row[5]), closeTime:Number(row[6] || 0) };
  if(!Number.isFinite(out.openTime)||![out.open,out.high,out.low,out.close,out.volume].every(Number.isFinite)) return null;
  return out;
}
function closedOnly(candles, timeframe, now=Date.now()) {
  const ms=TF_MS[timeframe];
  return candles.filter(c=>c.openTime+ms<=now+1000).sort((a,b)=>a.openTime-b.openTime);
}

class ServerFeatureEngine {
  constructor({ config, log=console.log }) {
    this.config=config; this.log=log; this.timer=null; this.running=false; this.refreshing=false;
    const persistentRoot=String(process.env.ALPS_PERSISTENT_DIR || '').trim() || (fs.existsSync('/var/data')?'/var/data/alps':path.join(config.rootDir,'data'));
    this.dataDir=path.resolve(persistentRoot);
    this.cacheFile=path.join(this.dataDir,'v10200-feature-cache.json');
    this.rows=new Map();
    this.lastRefreshStartedAt=null; this.lastRefreshCompletedAt=null; this.lastError=null; this.refreshCount=0;
    this.sourceCounts={}; this.lastCycle={status:'NOT_STARTED',due:0,loaded:0,failed:0};
  }
  key(pair,tf){return `${canonicalPair(pair)}|${tf}`;}
  async init(){
    await fsp.mkdir(this.dataDir,{recursive:true});
    const saved=await fsp.readFile(this.cacheFile,'utf8').then(JSON.parse).catch(()=>null);
    if(saved&&Array.isArray(saved.rows)) for(const row of saved.rows) this.rows.set(this.key(row.pair,row.timeframe),row);
    return this.view();
  }
  start(){
    if(this.timer)return;
    this.timer=setInterval(()=>this.refreshDue('interval').catch(e=>this.log('[feature-engine] refresh failed',summarizeError(e))),Math.max(15000,finite(process.env.ALPS_V102_FEATURE_SCAN_MS,30000)));
    this.timer.unref();
    setTimeout(()=>this.refreshDue('startup').catch(e=>this.log('[feature-engine] startup refresh failed',summarizeError(e))),1000).unref();
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
  isDue(pair,tf,now=Date.now()){
    const row=this.rows.get(this.key(pair,tf));
    if(!row||!row.lastClosedCandleOpenTime)return true;
    const expectedOpen=Math.floor(now/TF_MS[tf])*TF_MS[tf]-TF_MS[tf];
    return Number(row.lastClosedCandleOpenTime)<expectedOpen || now-timestamp(row.fetchedAt)>Math.min(TF_MS[tf]/2,300000);
  }
  async refreshDue(reason='manual'){
    if(this.refreshing)return this.view();
    this.refreshing=true; this.lastRefreshStartedAt=iso(); this.lastError=null;
    try{
      const due=[]; for(const pair of PAIRS)for(const tf of TIMEFRAMES)if(this.isDue(pair,tf))due.push({pair,tf});
      let cursor=0,loaded=0,failed=0;
      const workers=Array.from({length:Math.min(5,due.length||1)},async()=>{
        while(cursor<due.length){const item=due[cursor++];try{const row=await this.fetchAndBuild(item.pair,item.tf);this.rows.set(this.key(item.pair,item.tf),row);loaded++;}catch(e){failed++;const old=this.rows.get(this.key(item.pair,item.tf));this.rows.set(this.key(item.pair,item.tf),{...(old||{pair:item.pair,timeframe:item.tf}),status:old?'STALE_RETAINED_AFTER_FETCH_FAILURE':'MISSING',lastError:summarizeError(e),lastAttemptAt:iso()});}}
      });
      await Promise.all(workers);
      this.lastCycle={status:failed?'PARTIAL':'COMPLETE',reason,due:due.length,loaded,failed,completedAt:iso()};
      this.lastRefreshCompletedAt=iso(); this.refreshCount++;
      await this.persist();
      return this.view();
    }catch(e){this.lastError=summarizeError(e);throw e;}finally{this.refreshing=false;}
  }
  async persist(){
    const tmp=`${this.cacheFile}.tmp-${process.pid}-${Date.now()}`;
    const payload={schema:'alps.v10200.featureCache.v1',version:this.config.version,generatedAt:iso(),rows:[...this.rows.values()]};
    await fsp.writeFile(tmp,JSON.stringify(payload)); await fsp.rename(tmp,this.cacheFile);
  }
  async fetchJson(url,timeoutMs=12000){
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{const r=await fetch(url,{headers:{accept:'application/json'},signal:controller.signal});if(!r.ok)throw new Error(`HTTP_${r.status}`);return await r.json();}finally{clearTimeout(timer);}
  }
  async fetchBinance(pair,tf){
    const symbol=BINANCE_ALIAS[pair]||pair;
    const urls=[
      `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=300`,
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=300`,
    ];
    let last;for(const url of urls){try{const raw=await this.fetchJson(url);const rows=raw.map(normalizeCandle).filter(Boolean);if(rows.length>=60)return{candles:rows,source:url.includes('vision')?'BINANCE_VISION_KLINES':'BINANCE_KLINES',resolvedSymbol:symbol};}catch(e){last=e;}}
    throw last||new Error('BINANCE_NO_CANDLES');
  }
  async fetchOkx(pair,tf){
    const inst=OKX_ALIAS[pair]||pair.replace(/USDT$/,'-USDT');
    const raw=await this.fetchJson(`https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=${OKX_BAR[tf]}&limit=300`);
    const rows=(raw&&raw.data||[]).map(r=>normalizeCandle([r[0],r[1],r[2],r[3],r[4],r[5],Number(r[0])+TF_MS[tf]-1])).filter(Boolean).reverse();
    if(rows.length<60)throw new Error('OKX_INSUFFICIENT_CANDLES');
    return{candles:rows,source:'OKX_SPOT_KLINES',resolvedSymbol:inst};
  }
  async fetchBybit(pair,tf){
    const symbol=BYBIT_ALIAS[pair]||pair;
    const raw=await this.fetchJson(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${BYBIT_INTERVAL[tf]}&limit=300`);
    const rows=(raw&&raw.result&&raw.result.list||[]).map(r=>normalizeCandle([r[0],r[1],r[2],r[3],r[4],r[5],Number(r[0])+TF_MS[tf]-1])).filter(Boolean).reverse();
    if(rows.length<60)throw new Error('BYBIT_INSUFFICIENT_CANDLES');
    return{candles:rows,source:'BYBIT_SPOT_KLINES',resolvedSymbol:symbol};
  }
  async fetchAndBuild(pair,tf){
    let result,last;for(const fn of [this.fetchBinance.bind(this),this.fetchOkx.bind(this),this.fetchBybit.bind(this)]){try{result=await fn(pair,tf);break;}catch(e){last=e;}}
    if(!result)throw last||new Error('ALL_CANDLE_SOURCES_FAILED');
    const candles=closedOnly(result.candles,tf);if(candles.length<60)throw new Error('INSUFFICIENT_CLOSED_CANDLES');
    const closes=candles.map(c=>c.close),volumes=candles.map(c=>c.volume),lastC=candles[candles.length-1];
    const fast=ema(closes.slice(-120),20),slow=ema(closes.slice(-180),50),a=atr(candles.slice(-80),14),r=rsi(closes.slice(-80),14);
    const atrPct=a&&lastC.close?100*a/lastC.close:0;
    let regime='RANGE';if(fast&&slow){const spread=(fast-slow)/lastC.close;if(spread>Math.max(0.001,atrPct/500))regime='TREND_UP';else if(spread<-Math.max(0.001,atrPct/500))regime='TREND_DOWN';}
    this.sourceCounts[result.source]=(this.sourceCounts[result.source]||0)+1;
    return{
      schema:'alps.v10200.featureRow.v1',version:this.config.version,pair,timeframe:tf,status:'LOADED',source:result.source,resolvedSymbol:result.resolvedSymbol,
      fetchedAt:iso(),closedCandleCount:candles.length,lastClosedCandleOpenTime:lastC.openTime,lastClosedCandleAt:iso(lastC.openTime+TF_MS[tf]-1),
      ohlcv:{open:lastC.open,high:lastC.high,low:lastC.low,close:lastC.close,volume:lastC.volume},
      features:{ema20:round(fast,10),ema50:round(slow,10),atr14:round(a,10),atrPct:round(atrPct,6),rsi14:round(r,4),return1:round((lastC.close/closes[closes.length-2]-1)*100,6),return5:closes.length>5?round((lastC.close/closes[closes.length-6]-1)*100,6):null,volumeZ20:round(zscoreLast(volumes,20),4),regime},
      chartCandles:candles.slice(-300),lastError:null,
    };
  }
  rowFresh(row,now=Date.now()){
    if(!row||row.status!=='LOADED'||!row.lastClosedCandleOpenTime)return false;
    const ms=TF_MS[row.timeframe];const expected=Math.floor(now/ms)*ms-ms;
    return Number(row.lastClosedCandleOpenTime)>=expected && now-timestamp(row.fetchedAt)<=Math.max(600000,ms);
  }
  view(now=Date.now()){
    const rows=[];let fresh=0,loaded=0,partial=0,missing=0,aliasNeeded=0;
    for(const pair of PAIRS)for(const tf of TIMEFRAMES){const row=this.rows.get(this.key(pair,tf))||{pair,timeframe:tf,status:'MISSING'};const isFresh=this.rowFresh(row,now);if(row.status==='LOADED')loaded++;else if(text(row.status).includes('STALE'))partial++;else if(text(row.status).includes('ALIAS'))aliasNeeded++;else missing++;if(isFresh)fresh++;rows.push({...row,fresh:isFresh,chartCandles:undefined});}
    const ready=fresh===PAIRS.length*TIMEFRAMES.length;
    return{
      schema:'alps.v10200.serverFeatureEngine.v1',version:this.config.version,generatedAt:iso(now),status:ready?'FEATURE_EPOCH_READY_35_OF_35':(loaded||partial?'FEATURE_EPOCH_PARTIAL':'WAITING_FOR_FEATURES'),
      installed:true,ready,requiredPairFrames:35,featureRowsFound:loaded,freshFeaturePairFrames:fresh,loaded,partial,missing,aliasNeeded,
      pairs:PAIRS,timeframes:TIMEFRAMES,lastRefreshStartedAt:this.lastRefreshStartedAt,lastRefreshCompletedAt:this.lastRefreshCompletedAt,refreshing:this.refreshing,refreshCount:this.refreshCount,lastCycle:this.lastCycle,lastError:this.lastError,sourceCounts:this.sourceCounts,rows,
      rule:'Features are built server-side from real closed spot candles. IndexedDB and browser feature rows are not operational dependencies.',
    };
  }
  chart(pair,tf){const row=this.rows.get(this.key(pair,tf));return row?{schema:'alps.v10200.chartTruth.v1',version:this.config.version,pair:canonicalPair(pair),timeframe:tf,status:row.status,source:row.source,generatedAt:iso(),candles:row.chartCandles||[],features:row.features||{},fresh:this.rowFresh(row)}:{schema:'alps.v10200.chartTruth.v1',version:this.config.version,pair:canonicalPair(pair),timeframe:tf,status:'MISSING',candles:[],fresh:false};}
}

module.exports={ServerFeatureEngine,PAIRS,TIMEFRAMES,TF_MS,closedOnly};
