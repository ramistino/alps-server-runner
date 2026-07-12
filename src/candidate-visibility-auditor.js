'use strict';

const { asArray, asObject, canonicalPair, canonicalTimeframe, finite, round, text } = require('./utils');

function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function candidateRows(nativeView) {
  const root=asObject(nativeView);
  return asArray(root.candidates || root.rows || root.nativeForwardPoolCandidates || root.pool || root.items);
}
function normalizeDirection(row) {
  const raw=text(row.direction || row.side || row.signal || row.bias).toUpperCase();
  if(raw.includes('LONG')||raw==='BUY')return'LONG';
  if(raw.includes('SHORT')||raw==='SELL')return'SHORT';
  return'';
}
function normalizeCandidate(row,index=0) {
  const pair=canonicalPair(row.pair || row.symbol || row.asset);
  const timeframe=canonicalTimeframe(row.timeframe || row.tf || row.interval);
  const direction=normalizeDirection(row);
  const plan=asObject(row.riskPlan || row.executionPlan || row.tradePlan || row.levels);
  const entry=firstNumber(row.entry,row.entryPrice,row.entryMid,row.triggerPrice,row.entryZoneMid,row.zoneMid,plan.entry,plan.entryPrice);
  const stop=firstNumber(row.stop,row.stopLoss,row.sl,row.invalidationPrice,row.stopPrice,row.initialStop,row.openedStop,plan.stop,plan.stopPrice);
  const target=firstNumber(row.target,row.takeProfit,row.tp,row.targetPrice,row.exitTarget,row.initialTarget,row.openedTarget,plan.target,plan.targetPrice);
  let zoneLow=firstNumber(row.zoneLow,row.entryLow,row.entryZoneLow,row.entryMin,row.entryRangeLow);
  let zoneHigh=firstNumber(row.zoneHigh,row.entryHigh,row.entryZoneHigh,row.entryMax,row.entryRangeHigh);
  const zoneMid=firstNumber(row.entryZoneMid,row.zoneMid,row.setupPrice,entry);
  const buffer=firstNumber(row.entryZoneBuffer,row.zoneBuffer,row.entryBuffer,row.entryZoneBufferAbs);
  const zoneBps=firstNumber(row.entryZoneBps,row.zoneBps,row.recoverableEntry && row.recoverableEntry.entryZoneBps);
  if(zoneMid!==null&&buffer!==null){if(zoneLow===null)zoneLow=zoneMid-Math.abs(buffer);if(zoneHigh===null)zoneHigh=zoneMid+Math.abs(buffer);}
  if(zoneMid!==null&&zoneBps!==null&&zoneBps>0){const abs=Math.abs(zoneMid)*zoneBps/10000;if(zoneLow===null)zoneLow=zoneMid-abs;if(zoneHigh===null)zoneHigh=zoneMid+abs;}
  if(zoneLow!==null&&zoneHigh!==null&&zoneLow>zoneHigh)[zoneLow,zoneHigh]=[zoneHigh,zoneLow];
  const key=text(row.key || row.candidateKey || row.id || row.signalId || `${pair}|${timeframe}|${direction}|${entry}|${stop}|${target}|${index}`);
  const reasons=[];
  if(!pair)reasons.push('PAIR_UNDEFINED');
  if(!timeframe)reasons.push('TIMEFRAME_UNDEFINED');
  if(!direction)reasons.push('DIRECTION_UNDEFINED');
  if(entry===null)reasons.push('ENTRY_UNDEFINED');
  if(stop===null)reasons.push('STOP_UNDEFINED');
  if(target===null)reasons.push('TARGET_UNDEFINED');
  if(entry!==null&&stop!==null&&target!==null){
    if(direction==='LONG'&&!(stop<entry&&target>entry))reasons.push('LONG_LEVEL_ORDER_INVALID');
    if(direction==='SHORT'&&!(stop>entry&&target<entry))reasons.push('SHORT_LEVEL_ORDER_INVALID');
  }
  if(zoneLow===null||zoneHigh===null)reasons.push('ENTRY_ZONE_UNDEFINED');
  if(zoneLow!==null&&zoneHigh!==null&&entry!==null&&!(entry>=zoneLow&&entry<=zoneHigh))reasons.push('ENTRY_OUTSIDE_ZONE');
  return{key,pair,timeframe,direction,entry,stop,target,zoneLow,zoneHigh,reasons,valid:reasons.length===0,raw:row};
}
function classifyPrice(candidate,price) {
  if(!candidate.valid)return{status:'INVALID_CONTRACT',action:'QUARANTINE'};
  if(!Number.isFinite(price))return{status:'PRICE_UNAVAILABLE',action:'WAIT'};
  if(price>=candidate.zoneLow&&price<=candidate.zoneHigh)return{status:'IN_ENTRY_ZONE',action:'ENTRY_ELIGIBLE'};
  if(price<candidate.zoneLow)return{status:'BELOW_ENTRY_ZONE',action:'WAIT'};
  return{status:'ABOVE_ENTRY_ZONE',action:'WAIT'};
}
function priceMapFromHealth(current) {
  const map=new Map();
  for(const row of asArray(current && current.livePriceFetchProof)){
    const pair=canonicalPair(row.requestedSymbol || row.symbol);
    const price=Number(row.price);
    if(pair&&Number.isFinite(price))map.set(pair,{price,source:row.source||'UNKNOWN',priceAt:row.priceAt||null});
  }
  for(const row of asArray(current && current.lastCheckedPrices)){
    const pair=canonicalPair(row.pair || row.symbol);
    const price=Number(row.livePrice || row.price);
    if(pair&&Number.isFinite(price)&&!map.has(pair))map.set(pair,{price,source:row.priceSource||'LAST_CHECKED_PRICE',priceAt:row.priceAt||null});
  }
  return map;
}
function auditCandidateVisibility({nativeView,currentHealth,legacyPaperSeen=0}) {
  const rawRows=candidateRows(nativeView);
  const prices=priceMapFromHealth(currentHealth);
  const normalized=rawRows.map(normalizeCandidate);
  const reasons={};const statuses={};const valid=[];const invalid=[];const eligible=[];
  for(const row of normalized){
    for(const reason of row.reasons)reasons[reason]=(reasons[reason]||0)+1;
    const p=prices.get(row.pair);
    const c=classifyPrice(row,p&&p.price);
    statuses[c.status]=(statuses[c.status]||0)+1;
    const compact={key:row.key,pair:row.pair,timeframe:row.timeframe,direction:row.direction,entry:row.entry,stop:row.stop,target:row.target,zoneLow:row.zoneLow,zoneHigh:row.zoneHigh,price:p&&p.price||null,priceSource:p&&p.source||null,status:c.status,action:c.action,reasons:row.reasons};
    if(row.valid){valid.push(compact);if(c.action==='ENTRY_ELIGIBLE')eligible.push(compact);}else invalid.push(compact);
  }
  const total=normalized.length;
  const visibleByV102=valid.length;
  const legacySeen=Math.max(0,finite(legacyPaperSeen,0));
  const legacyGap=Math.max(0,total-legacySeen);
  const explainedByInvalid=Math.min(legacyGap,invalid.length);
  const unresolved=Math.max(0,legacyGap-explainedByInvalid);
  return{
    schema:'alps.v10200.candidateVisibilityAudit.v1',status:total?'AUDIT_READY':'WAITING_FOR_NATIVE_POOL_ROWS',
    totalCandidates:total,validExecutionContracts:valid.length,invalidContracts:invalid.length,
    v102PaperVisibility:visibleByV102,legacyPaperVisibility:legacySeen,legacyVisibilityGap:legacyGap,
    gapExplainedByInvalidContracts:explainedByInvalid,unresolvedLegacyVisibilityGap:unresolved,
    entryEligibleNow:eligible.length,priceCoveragePairs:[...prices.keys()],reasonCounts:reasons,priceStatusCounts:statuses,
    eligibleSample:eligible.slice(0,40),invalidSample:invalid.slice(0,40),validSample:valid.slice(0,20),
    rule:'Every native-pool candidate is normalized once. Missing direction/entry/stop/target/zone is classified explicitly; no candidate disappears between latch and paper visibility without a published reason.',
  };
}
module.exports={candidateRows,normalizeCandidate,classifyPrice,auditCandidateVisibility};
