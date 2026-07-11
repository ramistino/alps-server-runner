/**
 * ALPS Runner Trade Export v1.2.3
 *
 * Exposes real ALPS paper-forward open/closed trades for ALPS reports, including Paper Entry openedTrades export sync and server-authority paper ledger source preservation.
 * This module does not change strategy logic and does not open live execution.
 */

'use strict';

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[,%$≈]/g, '').replace(/^\+/, '').trim());
  return Number.isFinite(n) ? n : null;
}

function firstValue(obj, names) {
  for (const name of names) {
    if (obj && obj[name] !== undefined && obj[name] !== null && obj[name] !== '') return obj[name];
  }
  return undefined;
}

function normalizeDirection(value) {
  const v = String(value || '').toUpperCase();
  if (v === 'BUY') return 'LONG';
  if (v === 'SELL') return 'SHORT';
  if (v === 'LONG' || v === 'SHORT') return v;
  return '';
}

function normalizePair(value) {
  const raw = String(value || '').toUpperCase().trim();
  // ALPS often stores symbol as BTCUSDT_4h. Pair must stay BTCUSDT, not BTCUSDT4H.
  const withoutFrame = raw.split('_')[0].split('|')[0];
  return withoutFrame.replace(/[^A-Z0-9]/g, '');
}

function inferTimeframe(trade) {
  const explicit = String(firstValue(trade, ['timeframe', 'tf', 'frame']) || '').trim();
  if (explicit) return explicit;
  const raw = String(firstValue(trade, ['key', 'sym', 'symbol', 'market']) || '');
  const m = raw.match(/(?:_|\|)(5m|15m|30m|1h|4h|1d)$/i);
  return m ? m[1] : '';
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (Number.isFinite(n) && n > 10_000_000_000) return new Date(n).toISOString();
  if (Number.isFinite(n) && n > 1_000_000_000) return new Date(n * 1000).toISOString();
  return String(value);
}

function safePct(trade, names, bpsNames) {
  const direct = safeNumber(firstValue(trade, names));
  if (direct !== null) return direct;
  const bps = safeNumber(firstValue(trade, bpsNames || []));
  return bps === null ? null : bps / 100;
}

function buildId(parts) {
  return parts.filter(x => x !== undefined && x !== null && x !== '').join('-').replace(/[^A-Za-z0-9_.:-]/g, '_');
}

function normalizeOpenTrade(trade, index = 0) {
  const pair = normalizePair(firstValue(trade, ['pair', 'baseSymbol', 'symbol', 'sym', 'market', 'asset']));
  const timeframe = inferTimeframe(trade);
  const direction = normalizeDirection(firstValue(trade, ['direction', 'dir', 'side', 'bias']));
  const strategy = String(firstValue(trade, ['strategy', 'stratName', 'rootStrategy', 'setup', 'name', 'label', 'hypothesis']) || firstValue(trade?.fingerprint || {}, ['cleanName', 'rootName']) || '');
  const entry = safeNumber(firstValue(trade, ['entry', 'entryPrice', 'open', 'openPrice', 'signalPrice', 'price']));
  const current = safeNumber(firstValue(trade, ['current', 'markPrice', 'last', 'lastPrice', 'currentPrice']));
  const stop = safeNumber(firstValue(trade, ['stop', 'sl', 'stopLoss']));
  const target = safeNumber(firstValue(trade, ['target', 'tp', 'takeProfit', 'targetPrice']));
  const pnlPct = safePct(trade, ['pnlPct', 'returnPct', 'profitPct', 'unrealizedPnlPct'], ['pnlBps', 'unrealizedPnlBps']);
  const pnlBps = safeNumber(firstValue(trade, ['pnlBps', 'unrealizedPnlBps', 'pnl']));
  const openedAt = normalizeTimestamp(firstValue(trade, ['openedAt', 'openTime', 'timestamp', 'date', 'createdAt', 'signalTime', 'generatedAt', 'ts']));
  const statusRaw = String(firstValue(trade, ['status', 'state', 'outcome']) || 'OPEN').toUpperCase();
  const status = statusRaw.includes('CLOSE') ? 'CLOSED' : 'OPEN';

  if (!pair || !direction || entry === null) return null;

  const tradeId = String(firstValue(trade, ['tradeId', 'id', 'signalId']) || buildId([pair, timeframe || 'tf', direction, openedAt || Date.now(), index]));
  return {
    tradeId,
    pair,
    timeframe: timeframe || '',
    direction,
    strategy,
    entry,
    current,
    stop,
    target,
    pnlPct,
    pnlBps,
    status,
    openedAt,
    mfeBps: safeNumber(firstValue(trade, ['mfeBps'])),
    maeBps: safeNumber(firstValue(trade, ['maeBps'])),
    ariAction: firstValue(trade, ['ariAction']) || firstValue(trade?.ariDecision || {}, ['action']),
    ariConfidence: safeNumber(firstValue(trade, ['ariConfidence']) || firstValue(trade?.ariDecision || {}, ['confidence'])),
    regime: firstValue(trade, ['marketRegime', 'regimeSummary']) || firstValue(trade?.regime || {}, ['regime']),
    freshness: firstValue(trade, ['freshnessStatus']),
    initialStop: safeNumber(firstValue(trade, ['initialStop','openedStop','originalStop'])),
    initialRisk: safeNumber(firstValue(trade, ['initialRisk','openedRisk','risk'])),
    riskGuardStatus: firstValue(trade, ['riskGuardStatus']) || '',
    breakevenApplied: !!firstValue(trade, ['breakevenApplied','breakEvenMoved']),
    profitLockApplied: !!firstValue(trade, ['profitLockApplied','profitLocked']),
    source: firstValue(trade, ['__alpsSource', 'source', 'paperSource']) || 'ALPS_OPEN_LEDGER'
  };
}

function normalizeClosedTrade(trade, index = 0) {
  const pair = normalizePair(firstValue(trade, ['pair', 'baseSymbol', 'symbol', 'sym', 'market', 'asset']));
  const timeframe = inferTimeframe(trade);
  const direction = normalizeDirection(firstValue(trade, ['direction', 'dir', 'side', 'bias']));
  const strategy = String(firstValue(trade, ['strategy', 'stratName', 'rootStrategy', 'setup', 'name', 'label', 'hypothesis']) || firstValue(trade?.fingerprint || {}, ['cleanName', 'rootName']) || '');
  const entry = safeNumber(firstValue(trade, ['entry', 'entryPrice', 'open', 'openPrice', 'signalPrice', 'price']));
  const exit = safeNumber(firstValue(trade, ['exit', 'exitPrice', 'close', 'closePrice', 'finalPrice']));
  const pnlPct = safePct(trade, ['pnlPct', 'returnPct', 'profitPct', 'realizedPnlPct'], ['pnlBps', 'realizedPnlBps']);
  const pnlBps = safeNumber(firstValue(trade, ['pnlBps', 'realizedPnlBps', 'pnl']));
  const bars = safeNumber(firstValue(trade, ['bars', 'durationBars', 'holdBars']));
  const openedAt = normalizeTimestamp(firstValue(trade, ['openedAt', 'openTime', 'timestamp', 'date', 'createdAt', 'signalTime', 'generatedAt', 'ts']));
  const closedAt = normalizeTimestamp(firstValue(trade, ['closedAt', 'closeTime', 'exitTime', 'completedAt', 'exitTs'])) || openedAt || '';
  const resultSignal = pnlBps !== null ? pnlBps : (pnlPct !== null ? pnlPct * 100 : null);
  const result = String(firstValue(trade, ['result', 'outcome']) || (resultSignal > 0 ? 'WIN' : resultSignal < 0 ? 'LOSS' : ''));

  if (!pair || !direction || entry === null) return null;

  const tradeId = String(firstValue(trade, ['tradeId', 'id', 'signalId']) || buildId([pair, timeframe || 'tf', direction, closedAt || openedAt || Date.now(), index]));
  return {
    tradeId,
    pair,
    timeframe: timeframe || '',
    direction,
    strategy,
    entry,
    exit,
    pnlPct,
    pnlBps,
    bars,
    result,
    status: 'CLOSED',
    openedAt,
    closedAt,
    mfeBps: safeNumber(firstValue(trade, ['mfeBps'])),
    maeBps: safeNumber(firstValue(trade, ['maeBps'])),
    exitReason: firstValue(trade, ['exitReason','closeReason','closedBy']),
    closeReason: firstValue(trade, ['closeReason','exitReason','closedBy']),
    resultR: safeNumber(firstValue(trade, ['resultR','rMultipleResult','realizedR'])),
    closeWritebackStatus: firstValue(trade, ['closeWritebackStatus']) || '',
    ariAction: firstValue(trade, ['ariAction']) || firstValue(trade?.ariDecision || {}, ['action']),
    ariConfidence: safeNumber(firstValue(trade, ['ariConfidence']) || firstValue(trade?.ariDecision || {}, ['confidence'])),
    regime: firstValue(trade, ['marketRegime', 'regimeSummary']) || firstValue(trade?.regime || {}, ['regime']),
    freshness: firstValue(trade, ['freshnessStatus']),
    source: firstValue(trade, ['__alpsSource', 'source', 'paperSource']) || 'ALPS_CLOSED_LEDGER'
  };
}

function normalizeCloseReason(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  if (raw === 'LIVE_TARGET_HIT') return 'TARGET_HIT';
  if (raw === 'LIVE_STOP_HIT') return 'STOP_HIT';
  if (raw === 'LIVE_TRAILED_STOP_HIT' || raw === 'TRAILING_STOP_HIT') return 'TRAILED_STOP_HIT';
  return raw;
}

function dedupe(rows) {
  const out = [];
  const indexById = new Map();
  const indexBySemantic = new Map();
  for (const row of rows) {
    if (!row) continue;
    const tradeId = String(row.tradeId || '').trim().toUpperCase();
    const idKey = tradeId ? `TRADEID|${tradeId}|${row.status || ''}` : '';
    const semanticKey = [
      'SEMANTIC',
      row.pair,
      row.timeframe,
      row.direction,
      row.entry,
      row.exit || row.current || '',
      row.result || '',
      normalizeCloseReason(row.closeReason || row.exitReason || ''),
      row.status
    ].join('|');

    let index = idKey && indexById.has(idKey) ? indexById.get(idKey) : undefined;
    if (index === undefined && semanticKey && indexBySemantic.has(semanticKey)) {
      index = indexBySemantic.get(semanticKey);
    }

    if (index === undefined) {
      index = out.length;
      out.push(row);
    } else {
      out[index] = { ...out[index], ...row };
    }

    if (idKey) indexById.set(idKey, index);
    if (semanticKey) indexBySemantic.set(semanticKey, index);
  }
  return out;
}

function buildTradeExport({ openTrades = [], closedTrades = [], sourceStats = {} } = {}) {
  const open = dedupe(openTrades.map(normalizeOpenTrade).filter(Boolean));
  const closed = dedupe(closedTrades.map(normalizeClosedTrade).filter(Boolean));

  return {
    schema: 'alps.runner.tradeExport.v1',
    generatedAt: new Date().toISOString(),
    openTrades: open,
    closedTrades: closed,
    stats: {
      openTrades: open.length,
      closedTrades: closed.length,
      sourceStats
    },
    note: 'Exported from ALPS server runner for ALPS reports. Fingerprints are not treated as executable trades.'
  };
}

function mdCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\|/g, '/');
}

function buildTradesMarkdown(exported) {
  const open = exported?.openTrades || [];
  const closed = exported?.closedTrades || [];
  const stats = exported?.stats || {};

  const openRows = open.map(t =>
    `| ${mdCell(t.tradeId)} | ${mdCell(t.pair)} | ${mdCell(t.timeframe)} | ${mdCell(t.direction)} | ${mdCell(t.strategy)} | ${mdCell(t.entry)} | ${mdCell(t.current)} | ${mdCell(t.stop)} | ${mdCell(t.target)} | ${mdCell(t.pnlBps ?? t.pnlPct)} | ${mdCell(t.status)} |`
  ).join('\n');

  const closedRows = closed.map(t =>
    `| ${mdCell(t.tradeId)} | ${mdCell(t.closedAt || t.openedAt)} | ${mdCell(t.pair)} | ${mdCell(t.timeframe)} | ${mdCell(t.direction)} | ${mdCell(t.strategy)} | ${mdCell(t.entry)} | ${mdCell(t.exit)} | ${mdCell(t.pnlBps ?? t.pnlPct)} | ${mdCell(t.bars)} | ${mdCell(t.result)} | ${mdCell(t.status)} |`
  ).join('\n');

  return [
    '## ALPS Trade Export JSON',
    '```json',
    JSON.stringify(exported || buildTradeExport(), null, 2),
    '```',
    '',
    '## ALPS Trade Export Summary',
    `- Schema: ${mdCell(exported?.schema || 'alps.runner.tradeExport.v1')}`,
    `- Generated At: ${mdCell(exported?.generatedAt || '')}`,
    `- Open Trades: ${mdCell(stats.openTrades ?? open.length)}`,
    `- Closed Trades: ${mdCell(stats.closedTrades ?? closed.length)}`,
    '',
    '## Open Trades',
    '| Trade ID | Pair | TF | Direction | Strategy | Entry | Current | Stop | Target | PnL bps/% | Status |',
    '|---|---|---|---|---|---:|---:|---:|---:|---:|---|',
    openRows || '|  |  |  |  | No open trades exported |  |  |  |  |  |  |',
    '',
    '## Closed Trades',
    '| Trade ID | Date | Pair | TF | Direction | Strategy | Entry | Exit | PnL% | Bars | Result | Status |',
    '|---|---|---|---|---|---|---:|---:|---:|---:|---|---|',
    closedRows || '|  |  |  |  |  | No closed trades exported |  |  |  |  |  |  |'
  ].join('\n');
}

module.exports = {
  normalizeOpenTrade,
  normalizeClosedTrade,
  buildTradeExport,
  buildTradesMarkdown
};
