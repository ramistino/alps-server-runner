#!/usr/bin/env node
'use strict';

/**
 * ALPS Closed Ledger Authority v10.1.47
 *
 * Scope:
 * - Paper-only ledger continuity.
 * - Never decreases the published closedTrades high-water mark within the new clean evidence epoch.
 * - Never removes canonical closed-trade rows.
 * - Does not modify strategies, pairs, timeframes, entries, exits, or dashboard logic.
 * - Does not enable testnet or live-capital execution.
 *
 * Integration target:
 * Call reconcile() immediately before currentHealth / health-lite is published.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 'alps.closedLedgerAuthority.v10147';
const VERSION = 'v10.1.47-closed-ledger-high-water-authority';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeUpper(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeCloseReason(value) {
  const reason = normalizeUpper(value).replace(/\s+/g, '_');
  if (reason === 'LIVE_TARGET_HIT') return 'TARGET_HIT';
  if (reason === 'LIVE_STOP_HIT') return 'STOP_HIT';
  if (reason === 'LIVE_TRAILED_STOP_HIT') return 'TRAILED_STOP_HIT';
  if (reason === 'TRAILING_STOP_HIT') return 'TRAILED_STOP_HIT';
  return reason;
}

function roundKeyNumber(value, digits = 10) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '';
}

function canonicalTradeId(row = {}) {
  return normalizeText(
    row.tradeId ||
    row.id ||
    row.signalId ||
    row.positionId ||
    row.orderId
  );
}

function semanticClosedKey(row = {}) {
  const tradeId = canonicalTradeId(row);
  if (tradeId) return `ID|${tradeId}`;

  return [
    'SEM',
    normalizeUpper(row.pair || row.symbol || row.baseSymbol),
    normalizeUpper(row.timeframe || row.tf),
    normalizeUpper(row.direction || row.side),
    normalizeUpper(row.strategy || row.stratName || row.setup || row.setupType),
    roundKeyNumber(row.entry),
    roundKeyNumber(row.exit || row.exitPrice),
    normalizeCloseReason(row.closeReason || row.exitReason || row.reason),
    normalizeText(row.openedAt || row.openTime || row.entryTime),
    normalizeText(row.closedAt || row.closeTime || row.exitTime),
  ].join('|');
}

function preferRicherRow(a = {}, b = {}) {
  const score = (row) => {
    const keys = [
      'tradeId', 'pair', 'timeframe', 'direction', 'strategy',
      'entry', 'exit', 'exitPrice', 'closeReason', 'result',
      'resultR', 'pnlBps', 'openedAt', 'closedAt', 'status'
    ];
    return keys.reduce((sum, key) => {
      const value = row[key];
      return sum + (value !== undefined && value !== null && value !== '' ? 1 : 0);
    }, 0);
  };
  return score(b) > score(a) ? { ...a, ...b } : { ...b, ...a };
}

function dedupeClosedRows(rows) {
  const map = new Map();
  for (const raw of asArray(rows)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = { ...raw, status: 'CLOSED' };
    const key = semanticClosedKey(row);
    if (!key || key === 'SEM||||||||||') continue;
    if (!map.has(key)) map.set(key, row);
    else map.set(key, preferRicherRow(map.get(key), row));
  }
  return [...map.values()];
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function exists(file) {
  try {
    await fsp.access(file, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonRecovering(primary, backup, fallback) {
  const candidates = [primary, backup];
  for (const file of candidates) {
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return { value: parsed, source: file, recovered: file !== primary };
      }
    } catch {
      // Try the next copy.
    }
  }
  return { value: fallback, source: '', recovered: false };
}

async function atomicWriteJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });

  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const backup = `${file}.bak`;
  const previous = `${file}.previous`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;

  if (await exists(file)) {
    await fsp.copyFile(file, previous).catch(() => undefined);
  }

  const handle = await fsp.open(temp, 'w', 0o600);
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  await fsp.rename(temp, file);
  await fsp.copyFile(file, backup).catch(() => undefined);
}

function defaultAuthority(seedFloor) {
  return {
    schema: SCHEMA,
    version: VERSION,
    paperOnly: true,
    liveCapitalExecution: false,
    testnetExecution: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    maxEverClosedTrades: Math.max(0, finiteNumber(seedFloor, 0)),
    lastPublishedClosedTrades: Math.max(0, finiteNumber(seedFloor, 0)),
    actualCanonicalRows: 0,
    missingHistoricalRows: Math.max(0, finiteNumber(seedFloor, 0)),
    lastIncomingUniqueClosedTrades: 0,
    lastCanonicalChecksum: '',
    regressionBlockCount: 0,
    lastRegressionAt: null,
    lastReason: 'INITIALIZED',
  };
}

function createClosedLedgerAuthority(options = {}) {
  const dataDir = path.resolve(
    options.dataDir ||
    process.env.ALPS_DATA_DIR ||
    path.join(__dirname, 'data')
  );

  const seedFloor = Math.max(
    0,
    finiteNumber(
      options.seedFloor,
      finiteNumber(process.env.ALPS_CLOSED_LEDGER_SEED_FLOOR, 0)
    )
  );

  const ledgerFile = path.resolve(
    options.ledgerFile ||
    path.join(dataDir, 'closed-ledger-monotonic-v10143.json')
  );

  const authorityFile = path.resolve(
    options.authorityFile ||
    path.join(dataDir, 'closed-ledger-authority-v10147.json')
  );

  let queue = Promise.resolve();

  async function reconcileUnlocked(incomingClosedTrades, reconcileOptions = {}) {
    if (reconcileOptions.testnetExecution === true) {
      throw new Error('Closed ledger authority is paper-only; testnet execution is not permitted.');
    }
    if (reconcileOptions.liveCapitalExecution === true) {
      throw new Error('Closed ledger authority is paper-only; live-capital execution is not permitted.');
    }

    const reason = normalizeText(reconcileOptions.reason || 'BEFORE_CURRENT_HEALTH_PUBLISH');
    const incomingUnique = dedupeClosedRows(incomingClosedTrades);

    const ledgerFallback = {
      schema: 'alps.closedLedgerMonotonic.v10143',
      version: VERSION,
      rows: [],
      updatedAt: null,
    };
    const ledgerRead = await readJsonRecovering(
      ledgerFile,
      `${ledgerFile}.bak`,
      ledgerFallback
    );

    const authorityRead = await readJsonRecovering(
      authorityFile,
      `${authorityFile}.bak`,
      defaultAuthority(seedFloor)
    );

    const persistedRows = dedupeClosedRows(
      ledgerRead.value.rows ||
      ledgerRead.value.closedTrades ||
      ledgerRead.value.trades
    );

    // Append-only union. Incoming source windows can shrink, but canonical rows cannot.
    const canonicalRows = dedupeClosedRows([...persistedRows, ...incomingUnique]);

    const previousPublished = Math.max(
      seedFloor,
      finiteNumber(authorityRead.value.maxEverClosedTrades, 0),
      finiteNumber(authorityRead.value.lastPublishedClosedTrades, 0),
      persistedRows.length
    );

    const maxEverClosedTrades = Math.max(previousPublished, canonicalRows.length);
    const regressionBlocked = incomingUnique.length < previousPublished;
    const droppedSinceAuthority = Math.max(0, previousPublished - incomingUnique.length);
    const missingHistoricalRows = Math.max(0, maxEverClosedTrades - canonicalRows.length);

    const checksum = sha256(JSON.stringify(canonicalRows));

    const ledgerDocument = {
      schema: 'alps.closedLedgerMonotonic.v10143',
      version: VERSION,
      paperOnly: true,
      liveCapitalExecution: false,
      testnetExecution: false,
      updatedAt: new Date().toISOString(),
      authorityFile,
      rowCount: canonicalRows.length,
      checksum,
      rows: canonicalRows,
    };

    // Never write a smaller canonical row set over a larger persisted row set.
    if (canonicalRows.length < persistedRows.length) {
      throw new Error(
        `Closed ledger invariant failed: canonical=${canonicalRows.length}, persisted=${persistedRows.length}`
      );
    }

    const authorityDocument = {
      ...defaultAuthority(seedFloor),
      ...authorityRead.value,
      schema: SCHEMA,
      version: VERSION,
      paperOnly: true,
      liveCapitalExecution: false,
      testnetExecution: false,
      updatedAt: new Date().toISOString(),
      maxEverClosedTrades,
      lastPublishedClosedTrades: maxEverClosedTrades,
      actualCanonicalRows: canonicalRows.length,
      missingHistoricalRows,
      lastIncomingUniqueClosedTrades: incomingUnique.length,
      lastCanonicalChecksum: checksum,
      regressionBlockCount:
        finiteNumber(authorityRead.value.regressionBlockCount, 0) +
        (regressionBlocked ? 1 : 0),
      lastRegressionAt: regressionBlocked
        ? new Date().toISOString()
        : authorityRead.value.lastRegressionAt || null,
      lastReason: reason,
      recoveredLedgerFromBackup: ledgerRead.recovered,
      recoveredAuthorityFromBackup: authorityRead.recovered,
    };

    // Write ledger first, then authority. Both are atomic and retain backups.
    await atomicWriteJson(ledgerFile, ledgerDocument);
    await atomicWriteJson(authorityFile, authorityDocument);

    const status = missingHistoricalRows > 0
      ? 'MONOTONIC_HIGH_WATER_RETAINED_ROWS_RECOVERY_REQUIRED'
      : regressionBlocked
        ? 'MONOTONIC_LEDGER_REGRESSION_BLOCKED'
        : 'MONOTONIC_LEDGER_AUTHORITY_OK';

    return {
      schema: 'alps.closedLedgerAuthorityResult.v10147',
      version: VERSION,
      paperOnly: true,
      liveCapitalExecution: false,
      testnetExecution: false,
      source: 'PERSISTENT_HIGH_WATER_PLUS_APPEND_ONLY_ROWS',
      authorityFile,
      persistentFile: ledgerFile,
      status,
      publishedClosedTrades: maxEverClosedTrades,
      maxEverClosedTrades,
      previousPublishedClosedTrades: previousPublished,
      incomingRawClosedTrades: asArray(incomingClosedTrades).length,
      incomingUniqueClosedTrades: incomingUnique.length,
      canonicalClosedRows: canonicalRows.length,
      missingHistoricalRows,
      closedLedgerDroppedSinceLastReport: droppedSinceAuthority,
      closedLedgerRegressionBlocked: regressionBlocked,
      recoveredLedgerFromBackup: ledgerRead.recovered,
      recoveredAuthorityFromBackup: authorityRead.recovered,
      checksum,
      rows: canonicalRows,
      rule:
        'closedTrades is the persistent high-water authority and can never decrease. ' +
        'Performance statistics must use canonical rows only; missing rows are never fabricated.',
    };
  }

  function reconcile(incomingClosedTrades, reconcileOptions = {}) {
    const task = () => reconcileUnlocked(incomingClosedTrades, reconcileOptions);
    queue = queue.then(task, task);
    return queue;
  }

  return {
    schema: SCHEMA,
    version: VERSION,
    dataDir,
    ledgerFile,
    authorityFile,
    seedFloor,
    reconcile,
  };
}

/**
 * Applies only count/authority fields to currentHealth.
 * It intentionally does not recalculate wins, losses, PnL, or PF when historical
 * rows are missing. Those metrics must remain based on real canonical rows or a
 * previously persisted complete stats snapshot.
 */
function applyAuthorityToCurrentHealth(currentHealth = {}, result = {}) {
  const next = { ...currentHealth };

  next.paperOnly = true;
  next.liveCapitalExecution = false;
  next.testnetExecutionStatus = 'TESTNET_EXECUTION_DISABLED';

  next.closedTrades = finiteNumber(result.publishedClosedTrades, next.closedTrades || 0);
  next.serverPaperLedgerClosed = next.closedTrades;

  next.rawClosedTrades = finiteNumber(
    result.incomingUniqueClosedTrades,
    next.rawClosedTrades || 0
  );
  next.uniqueClosedTrades = finiteNumber(
    result.canonicalClosedRows,
    next.uniqueClosedTrades || 0
  );

  next.closedLedgerAuthoritySource =
    result.source || 'PERSISTENT_HIGH_WATER_PLUS_APPEND_ONLY_ROWS';
  next.closedLedgerHighWaterMark = finiteNumber(
    result.maxEverClosedTrades,
    next.closedTrades
  );
  next.closedLedgerActualCanonicalRows = finiteNumber(
    result.canonicalClosedRows,
    0
  );
  next.closedLedgerMissingHistoricalRows = finiteNumber(
    result.missingHistoricalRows,
    0
  );
  next.closedLedgerRegressionBlocked = result.closedLedgerRegressionBlocked === true;
  next.closedLedgerDroppedSinceLastReport = finiteNumber(
    result.closedLedgerDroppedSinceLastReport,
    0
  );
  next.closedLedgerMonotonicStatus =
    result.status || 'MONOTONIC_LEDGER_AUTHORITY_OK';

  next.closedLedgerStatsCompleteness =
    next.closedLedgerMissingHistoricalRows > 0
      ? 'PARTIAL_ROWS_HIGH_WATER_COUNT_RETAINED'
      : 'FULL_CANONICAL_ROWS';

  return next;
}

module.exports = {
  SCHEMA,
  VERSION,
  createClosedLedgerAuthority,
  applyAuthorityToCurrentHealth,
  dedupeClosedRows,
  semanticClosedKey,
  normalizeCloseReason,
};

/*
Integration example in runner.js:

const {
  createClosedLedgerAuthority,
  applyAuthorityToCurrentHealth,
} = require('./ALPS_closed_ledger_authority_v10147');

const closedLedgerAuthority = createClosedLedgerAuthority({
  dataDir: DATA_DIR,
  seedFloor: Number(process.env.ALPS_CLOSED_LEDGER_SEED_FLOOR || 78),
});

// Immediately before publishing currentHealth / health-lite:
const authorityResult = await closedLedgerAuthority.reconcile(
  incomingClosedTrades,
  {
    reason: 'health-lite-endpoint-before-send',
    testnetExecution: false,
    liveCapitalExecution: false,
  }
);

currentHealth = applyAuthorityToCurrentHealth(currentHealth, authorityResult);

// Compute wins/losses/PnL/PF from authorityResult.rows only.
// When authorityResult.missingHistoricalRows > 0, do not invent missing stats.
// Retain the last complete persisted stats snapshot and expose
// closedLedgerStatsCompleteness = PARTIAL_ROWS_HIGH_WATER_COUNT_RETAINED.
*/
