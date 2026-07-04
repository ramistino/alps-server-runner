/**
 * ALPS Runner Trade Export v1.0
 *
 * Exposes real paper-forward open/closed trades for QuantEdge.
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
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function buildId(parts) {
  return parts.filter(x => x !== undefined && x !== null && x !== '').join('-').replace(/[^A-Za-z0-9_.:-]/g, '_');
}

function normalizeOpenTrade(trade, index = 0) {
  const pair = normalizePair(firstValue(trade, ['pair', 'symbol', 'market', 'asset']));
  const timeframe = String(firstValue(trade, ['timeframe', 'tf', 'frame']) || '').trim();
  const direction = normalizeDirection(firstValue(trade, ['direction', 'dir', 'side', 'bias']));
  const strategy = String(firstValue(trade, ['strategy', 'setup', 'name', 'label', 'hypothesis']) || '');
  const entry = safeNumber(firstValue(trade, ['entry', 'entryPrice', 'open', 'openPrice', 'signalPrice', 'price']));
  const current = safeNumber(firstValue(trade, ['current', 'markPrice', 'last', 'lastPrice', 'currentPrice']));
  const stop = safeNumber(firstValue(trade, ['stop', 'sl', 'stopLoss']));
  const target = safeNumber(firstValue(trade, ['target', 'tp', 'takeProfit', 'targetPrice']));
  const pnlPct = safeNumber(firstValue(trade, ['pnlPct', 'pnl', 'returnPct', 'profitPct', 'unrealizedPnlPct']));
  const openedAt = firstValue(trade, ['openedAt', 'openTime', 'timestamp', 'date', 'createdAt', 'signalTime']) || '';
  const statusRaw = String(firstValue(trade, ['status', 'state']) || 'OPEN').toUpperCase();
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
    status,
    openedAt,
    source: trade.__alpsSource || 'ALPS_OPEN_LEDGER'
  };
}

function normalizeClosedTrade(trade, index = 0) {
  const pair = normalizePair(firstValue(trade, ['pair', 'symbol', 'market', 'asset']));
  const timeframe = String(firstValue(trade, ['timeframe', 'tf', 'frame']) || '').trim();
  const direction = normalizeDirection(firstValue(trade, ['direction', 'dir', 'side', 'bias']));
  const strategy = String(firstValue(trade, ['strategy', 'setup', 'name', 'label', 'hypothesis']) || '');
  const entry = safeNumber(firstValue(trade, ['entry', 'entryPrice', 'open', 'openPrice', 'signalPrice', 'price']));
  const exit = safeNumber(firstValue(trade, ['exit', 'exitPrice', 'close', 'closePrice', 'finalPrice']));
  const pnlPct = safeNumber(firstValue(trade, ['pnlPct', 'pnl', 'returnPct', 'profitPct', 'realizedPnlPct']));
  const bars = safeNumber(firstValue(trade, ['bars', 'durationBars', 'holdBars']));
  const openedAt = firstValue(trade, ['openedAt', 'openTime', 'timestamp', 'date', 'createdAt', 'signalTime']) || '';
  const closedAt = firstValue(trade, ['closedAt', 'closeTime', 'exitTime', 'completedAt']) || openedAt || '';
  const result = String(firstValue(trade, ['result', 'outcome']) || (pnlPct > 0 ? 'WIN' : pnlPct < 0 ? 'LOSS' : ''));

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
    bars,
    result,
    status: 'CLOSED',
    openedAt,
    closedAt,
    source: trade.__alpsSource || 'ALPS_CLOSED_LEDGER'
  };
}

function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row) continue;
    const key = [
      row.tradeId,
      row.pair,
      row.timeframe,
      row.direction,
      row.entry,
      row.exit || row.current || '',
      row.pnlPct || '',
      row.status
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function buildTradeExport({ openTrades = [], closedTrades = [], sourceStats = {} } = {}) {
  const open = dedupe(openTrades.map(normalizeOpenTrade).filter(Boolean));
  const closed = dedupe(closedTrades.map(normalizeClosedTrade).filter(Boolean));

  return {
    schema: 'quantedge.alps.tradeExport.v1',
    generatedAt: new Date().toISOString(),
    openTrades: open,
    closedTrades: closed,
    stats: {
      openTrades: open.length,
      closedTrades: closed.length,
      sourceStats
    },
    note: 'Exported from ALPS server runner for QuantEdge sync. Fingerprints are not treated as executable trades.'
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
    `| ${mdCell(t.tradeId)} | ${mdCell(t.pair)} | ${mdCell(t.timeframe)} | ${mdCell(t.direction)} | ${mdCell(t.strategy)} | ${mdCell(t.entry)} | ${mdCell(t.current)} | ${mdCell(t.stop)} | ${mdCell(t.target)} | ${mdCell(t.pnlPct)} | ${mdCell(t.status)} |`
  ).join('\n');

  const closedRows = closed.map(t =>
    `| ${mdCell(t.tradeId)} | ${mdCell(t.closedAt || t.openedAt)} | ${mdCell(t.pair)} | ${mdCell(t.timeframe)} | ${mdCell(t.direction)} | ${mdCell(t.strategy)} | ${mdCell(t.entry)} | ${mdCell(t.exit)} | ${mdCell(t.pnlPct)} | ${mdCell(t.bars)} | ${mdCell(t.result)} | ${mdCell(t.status)} |`
  ).join('\n');

  return [
    '## QuantEdge Trade Export JSON',
    '```json',
    JSON.stringify(exported || buildTradeExport(), null, 2),
    '```',
    '',
    '## QuantEdge Trade Export Summary',
    `- Schema: ${mdCell(exported?.schema || 'quantedge.alps.tradeExport.v1')}`,
    `- Generated At: ${mdCell(exported?.generatedAt || '')}`,
    `- Open Trades: ${mdCell(stats.openTrades ?? open.length)}`,
    `- Closed Trades: ${mdCell(stats.closedTrades ?? closed.length)}`,
    '',
    '## Open Trades',
    '| Trade ID | Pair | TF | Direction | Strategy | Entry | Current | Stop | Target | PnL% | Status |',
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
