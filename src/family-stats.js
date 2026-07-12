'use strict';

const {
  asArray, canonicalPair, canonicalTimeframe, finite, round, stableSort, text, timestamp,
} = require('./utils');

function normalizedEntryKey(entry) {
  const n = finite(entry, NaN);
  if (!Number.isFinite(n) || n === 0) return 'NA';
  const magnitude = Math.max(0, Math.floor(Math.log10(Math.abs(n))));
  const decimals = Math.max(2, 8 - magnitude);
  return n.toFixed(Math.min(10, decimals));
}

function tradeOpenedAt(trade) {
  return timestamp(trade.openedAt || trade.openTime || trade.entryAt || trade.createdAt || trade.timestamp);
}
function tradeClosedAt(trade) {
  return timestamp(trade.closedAt || trade.closeTime || trade.exitAt || trade.updatedAt);
}
function tradeResultR(trade) {
  const direct = Number(trade.resultR);
  if (Number.isFinite(direct)) return direct;
  const result = text(trade.result || trade.outcome).toUpperCase();
  if (result === 'WIN') return 1;
  if (result === 'LOSS') return -1;
  if (result === 'BREAKEVEN' || result === 'BE') return 0;
  return NaN;
}
function tradePnlBps(trade) {
  const n = Number(trade.pnlBps);
  return Number.isFinite(n) ? n : NaN;
}
function tradeIdentity(trade) {
  const pair = canonicalPair(trade.pair || trade.symbol);
  const timeframe = canonicalTimeframe(trade.timeframe || trade.tf);
  const direction = text(trade.direction || trade.side).toUpperCase();
  const entry = normalizedEntryKey(trade.entry || trade.entryPrice);
  return { pair, timeframe, direction, entry };
}

function clusterTrades(rows, options = {}) {
  const epochStart = timestamp(options.epochStart);
  const bucketMs = Math.max(100, finite(options.bucketMs, 5000));
  const valid = [];
  for (const trade of asArray(rows)) {
    const id = tradeIdentity(trade);
    const openedAt = tradeOpenedAt(trade);
    const closedAt = tradeClosedAt(trade);
    const resultR = tradeResultR(trade);
    const pnlBps = tradePnlBps(trade);
    if (!id.pair || !id.timeframe || !['LONG','SHORT'].includes(id.direction)) continue;
    if (!openedAt || !closedAt || (epochStart && closedAt < epochStart)) continue;
    if (!Number.isFinite(resultR) && !Number.isFinite(pnlBps)) continue;
    valid.push({ trade, ...id, openedAt, closedAt, resultR, pnlBps });
  }
  const ordered = stableSort(valid, (a, b) => a.openedAt - b.openedAt || a.closedAt - b.closedAt);
  const families = [];
  const active = new Map();
  for (const row of ordered) {
    const base = `${row.pair}|${row.timeframe}|${row.direction}|${row.entry}`;
    const existing = active.get(base);
    if (existing && Math.abs(row.openedAt - existing.anchorOpenedAt) <= bucketMs) {
      existing.rows.push(row);
      existing.lastOpenedAt = row.openedAt;
    } else {
      const family = {
        key:`${base}|${Math.floor(row.openedAt / bucketMs)}`,
        anchorOpenedAt:row.openedAt,
        lastOpenedAt:row.openedAt,
        rows:[row],
      };
      active.set(base, family);
      families.push(family);
    }
  }
  return families.map(family => {
    const rValues = family.rows.map(x => x.resultR).filter(Number.isFinite);
    const bpsValues = family.rows.map(x => x.pnlBps).filter(Number.isFinite);
    const avgR = rValues.length ? rValues.reduce((a,b)=>a+b,0)/rValues.length : NaN;
    const avgBps = bpsValues.length ? bpsValues.reduce((a,b)=>a+b,0)/bpsValues.length : NaN;
    const representative = family.rows[0];
    return {
      familyId:family.key,
      pair:representative.pair,
      timeframe:representative.timeframe,
      direction:representative.direction,
      entry:Number(representative.entry),
      openedAt:new Date(representative.openedAt).toISOString(),
      closedAt:new Date(Math.max(...family.rows.map(x=>x.closedAt))).toISOString(),
      siblingTrades:family.rows.length,
      averageResultR:Number.isFinite(avgR) ? round(avgR, 6) : null,
      averagePnlBps:Number.isFinite(avgBps) ? round(avgBps, 6) : null,
      outcome:Number.isFinite(avgR)
        ? (avgR > 1e-9 ? 'WIN' : avgR < -1e-9 ? 'LOSS' : 'BREAKEVEN')
        : (avgBps > 1e-9 ? 'WIN' : avgBps < -1e-9 ? 'LOSS' : 'BREAKEVEN'),
      tradeIds:family.rows.map(x=>text(x.trade.tradeId || x.trade.id || x.trade.key)).filter(Boolean),
    };
  });
}

function aggregateFamilies(families) {
  const rows = asArray(families);
  const wins = rows.filter(x=>x.outcome==='WIN').length;
  const losses = rows.filter(x=>x.outcome==='LOSS').length;
  const breakeven = rows.filter(x=>x.outcome==='BREAKEVEN').length;
  const rValues = rows.map(x=>Number(x.averageResultR)).filter(Number.isFinite);
  const bpsValues = rows.map(x=>Number(x.averagePnlBps)).filter(Number.isFinite);
  const positiveR = rValues.filter(x=>x>0).reduce((a,b)=>a+b,0);
  const negativeR = rValues.filter(x=>x<0).reduce((a,b)=>a+b,0);
  const positiveBps = bpsValues.filter(x=>x>0).reduce((a,b)=>a+b,0);
  const negativeBps = bpsValues.filter(x=>x<0).reduce((a,b)=>a+b,0);
  const decisive = wins + losses;
  return {
    independentFamilies:rows.length,
    wins, losses, breakeven,
    winRate:rows.length ? round(wins * 100 / rows.length, 2) : 0,
    decisiveWinRate:decisive ? round(wins * 100 / decisive, 2) : 0,
    totalResultR:round(rValues.reduce((a,b)=>a+b,0), 6),
    avgResultR:rValues.length ? round(rValues.reduce((a,b)=>a+b,0)/rValues.length, 6) : 0,
    netPnlBps:round(bpsValues.reduce((a,b)=>a+b,0), 6),
    avgPnlBps:bpsValues.length ? round(bpsValues.reduce((a,b)=>a+b,0)/bpsValues.length, 6) : 0,
    profitFactorR:negativeR < 0 ? round(positiveR/Math.abs(negativeR), 6) : (positiveR > 0 ? null : 0),
    profitFactorBps:negativeBps < 0 ? round(positiveBps/Math.abs(negativeBps), 6) : (positiveBps > 0 ? null : 0),
  };
}

function groupStats(families, key) {
  const map = new Map();
  for (const row of families) {
    const value = row[key] || 'UNKNOWN';
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(row);
  }
  return [...map.entries()]
    .map(([value, rows]) => ({ key:value, ...aggregateFamilies(rows) }))
    .sort((a,b)=>b.independentFamilies-a.independentFamilies || String(a.key).localeCompare(String(b.key)));
}

function extractClosedTrades(source) {
  const root = source || {};
  const candidates = [
    root.closedTrades,
    root.closed,
    root.trades,
    root.rows,
    root.export && root.export.closedTrades,
    root.tradeExport && root.tradeExport.closedTrades,
    root.data && root.data.closedTrades,
    root.currentHealth && root.currentHealth.closedTrades,
  ];
  for (const value of candidates) {
    if (Array.isArray(value) && value.length) return value;
  }
  return [];
}

function learningFallback(learning) {
  const pairs = asArray(learning && learning.pairConfidence);
  const frames = asArray(learning && learning.timeframeConfidence);
  const independent = Math.max(
    0,
    finite(learning && learning.independentExperimentFamilies,
      finite(learning && learning.closedTradesLearned, 0))
  );
  const wins = pairs.reduce((sum,row)=>sum+Math.max(0,finite(row.wins,0)),0);
  const losses = pairs.reduce((sum,row)=>sum+Math.max(0,finite(row.losses,0)),0);
  const breakeven = pairs.reduce((sum,row)=>sum+Math.max(0,finite(row.breakeven,0)),0);
  const counted = wins + losses + breakeven;
  const denominator = independent || counted;
  const netPnlBps = round(pairs.reduce((sum,row)=>sum+finite(row.netPnlBps,0),0),6);
  const decisive = wins + losses;

  return {
    schema:'alps.v10200.familyAdjustedStats.v2',
    status:denominator > 0 ? 'LEARNING_AUTHORITY_FAMILY_STATS_READY' : 'WAITING_FOR_CURRENT_EPOCH_CLOSED_FAMILIES',
    source:'ADAPTIVE_EVIDENCE_LEARNING_FAMILY_AUTHORITY',
    temporalEvidenceEpochId:learning && learning.temporalEvidenceEpochId || null,
    temporalEvidenceEpochStartedAt:learning && learning.temporalEvidenceEpochStartedAt || null,
    rawClosedRowsObserved:finite(learning && learning.rawValidClosedTrades,0),
    correlatedSiblingTradesCollapsed:finite(learning && learning.correlatedSiblingTradesCollapsed,0),
    largestFamilySize:finite(learning && learning.largestExperimentFamilySize,0),
    independentFamilies:denominator,
    wins,
    losses,
    breakeven,
    winRate:denominator ? round(wins*100/denominator,2) : 0,
    decisiveWinRate:decisive ? round(wins*100/decisive,2) : 0,
    totalResultR:null,
    avgResultR:null,
    netPnlBps,
    avgPnlBps:denominator ? round(netPnlBps/denominator,6) : 0,
    profitFactorR:null,
    profitFactorBps:null,
    byPair:pairs.map(row=>({
      key:row.key,
      independentFamilies:finite(row.closed,0),
      wins:finite(row.wins,0),
      losses:finite(row.losses,0),
      breakeven:finite(row.breakeven,0),
      netPnlBps:finite(row.netPnlBps,0),
      confidenceScore:finite(row.confidenceScore,50),
      status:row.status || 'UNKNOWN',
    })),
    byTimeframe:frames.map(row=>({
      key:row.key,
      independentFamilies:finite(row.closed,0),
      wins:finite(row.wins,0),
      losses:finite(row.losses,0),
      breakeven:finite(row.breakeven,0),
      netPnlBps:finite(row.netPnlBps,0),
      confidenceScore:finite(row.confidenceScore,50),
      status:row.status || 'UNKNOWN',
    })),
    recentFamilies:[],
    rule:'When full closed rows are unavailable, the current-epoch adaptive learning authority is used because it already collapses correlated siblings into independent experiment families.',
  };
}

function buildFamilyAdjustedStats({ trades, learning }) {
  const closedTrades = extractClosedTrades(trades);
  const epochStart = learning && learning.temporalEvidenceEpochStartedAt;
  const families = clusterTrades(closedTrades, { epochStart, bucketMs:5000 });
  if (!families.length) return learningFallback(learning);

  const stats = aggregateFamilies(families);
  return {
    schema:'alps.v10200.familyAdjustedStats.v2',
    status:'FAMILY_ADJUSTED_STATS_READY',
    source:'CURRENT_EPOCH_CLOSED_TRADES_CLUSTERED_BY_SIGNAL_EVENT',
    temporalEvidenceEpochId:learning && learning.temporalEvidenceEpochId || null,
    temporalEvidenceEpochStartedAt:epochStart || null,
    rawClosedRowsObserved:closedTrades.length,
    correlatedSiblingTradesCollapsed:families.reduce((sum,x)=>sum+Math.max(0,x.siblingTrades-1),0),
    largestFamilySize:families.reduce((m,x)=>Math.max(m,x.siblingTrades),0),
    ...stats,
    byPair:groupStats(families,'pair'),
    byTimeframe:groupStats(families,'timeframe'),
    recentFamilies:families.slice(-30).reverse(),
    rule:'Primary performance authority is the mean payoff of independent signal families in the current temporal epoch. Raw target/exit siblings remain available only for ledger audit.',
  };
}

module.exports = {
  clusterTrades,
  aggregateFamilies,
  buildFamilyAdjustedStats,
  extractClosedTrades,
  learningFallback,
};
