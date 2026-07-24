'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const SCORING_SCHEMA = 'alps.gen2.evidenceScoringState.v1206';
const CLUSTER_SCHEMA = 'alps.gen2.evidenceClusterOutcome.v1206';
const SCORE_SCHEMA = 'alps.gen2.hypothesisEvidenceScore.v1206';
const SNAPSHOT_SCHEMA = 'alps.gen2.evidenceStatisticalSnapshot.v1206';
const CERTIFIED_EVIDENCE_CLASS = 'CERTIFIED_FORWARD_V12051';
const CERTIFIED_LEDGER_SCHEMA = 'alps.gen2.cryptoForwardShadowLedgerEvent.v12051';
const DEFAULT_THRESHOLDS = Object.freeze({
  minScoredClusters: 30,
  confidenceLevel: 0.95,
  z: 1.96,
  primaryLeg: 'R1',
  entryModelStarvedRate: 0.80,
  entryModelStarvedMinNominations: 25,
});
const RR_LEGS = Object.freeze([1, 2, 5]);

function iso(value = Date.now()) { return new Date(value).toISOString(); }
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function round(value, digits = 12) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}
function parseMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = Date.parse(String(value));
  return Number.isFinite(n) ? n : null;
}
function percentile(values, p) {
  const rows = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  if (rows.length === 1) return round(rows[0], 6);
  const index = (rows.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  const value = low === high ? rows[low] : rows[low] + (rows[high] - rows[low]) * (index - low);
  return round(value, 6);
}
function sha256Text(text) { return crypto.createHash('sha256').update(String(text)).digest('hex'); }
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
function stableHash(value) { return sha256Text(stableStringify(value)); }
function uniqueSorted(values) { return [...new Set(values.filter(v => v != null && v !== ''))].sort(); }
function symbolKeyFromEvent(event) {
  if (event.symbolKey) return String(event.symbolKey);
  const hypothesis = String(event.hypothesisId || '');
  const match = /^CRYPTO-([^-]+)-([^-]+)-(.+)$/.exec(hypothesis);
  if (match) return match[1];
  return String(event.symbol || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase() || null;
}
function familyFromHypothesis(hypothesisId) {
  const match = /^CRYPTO-[^-]+-[^-]+-(.+)$/.exec(String(hypothesisId || ''));
  return match ? match[1] : null;
}
function timeframeFromHypothesis(hypothesisId) {
  const match = /^CRYPTO-[^-]+-([^-]+)-(.+)$/.exec(String(hypothesisId || ''));
  return match ? match[1] : null;
}
function frameIntervalMs(timeframe) {
  const map = { '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000 };
  return map[String(timeframe)] || 300000;
}
function conflictGroupId(symbolKey, timeframe, signalCandleOpenTime) {
  const key = `${symbolKey}|${timeframe}|${signalCandleOpenTime}`;
  return `CG6-${sha256Text(key).slice(0, 24)}`;
}
function canonicalEntrySignature(candidate) {
  if (!candidate.entered) return null;
  return stableStringify({
    entry: round(candidate.entry),
    initialStop: round(candidate.initialStop),
    riskDistance: round(candidate.riskDistance),
    targets: RR_LEGS.map(rr => ({ rr, target: round(candidate.targets.get(rr)) })),
  });
}
function canonicalTerminalSignature(outcome) {
  return stableStringify({
    status: outcome.status,
    resultR: outcome.resultR == null ? null : round(outcome.resultR, 8),
    exitPrice: outcome.exitPrice == null ? null : round(outcome.exitPrice),
    closedAt: outcome.closedAt || null,
  });
}

function studentTCritical95(df) {
  if (!Number.isFinite(df) || df < 1) return null;
  const exact = [null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
    2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
  if (df <= 30) return exact[Math.floor(df)];
  if (df <= 40) return 2.042 + (2.021 - 2.042) * ((df - 30) / 10);
  if (df <= 60) return 2.021 + (2.000 - 2.021) * ((df - 40) / 20);
  if (df <= 120) return 2.000 + (1.980 - 2.000) * ((df - 60) / 60);
  return 1.96;
}
function meanConfidence95(values) {
  const rows = values.filter(Number.isFinite);
  const n = rows.length;
  if (!n) return { n: 0, mean: null, std: null, lower: null, upper: null, tCritical: null };
  const mean = rows.reduce((sum, n) => sum + n, 0) / n;
  if (n < 2) return { n, mean: round(mean, 8), std: null, lower: null, upper: null, tCritical: null };
  const variance = rows.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(Math.max(0, variance));
  const tCritical = studentTCritical95(n - 1);
  const margin = tCritical * std / Math.sqrt(n);
  return {
    n,
    mean: round(mean, 8),
    std: round(std, 8),
    lower: round(mean - margin, 8),
    upper: round(mean + margin, 8),
    tCritical: round(tCritical, 6),
  };
}
function wilsonInterval(wins, total, z = 1.96) {
  const n = Number(total);
  const w = Number(wins);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(w)) return { rate: null, lower: null, upper: null };
  const p = Math.min(1, Math.max(0, w / n));
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    rate: round(p, 8),
    lower: round((centre - margin) / denominator, 8),
    upper: round((centre + margin) / denominator, 8),
  };
}
function evidenceState(stats, thresholds) {
  if (stats.n < thresholds.minScoredClusters) return 'INSUFFICIENT_EVIDENCE';
  if (Number.isFinite(stats.meanRLower95) && stats.meanRLower95 > 0) return 'POSITIVE_EVIDENCE';
  if (Number.isFinite(stats.meanRUpper95) && stats.meanRUpper95 < 0) return 'NEGATIVE_EVIDENCE';
  return 'NOT_PROVEN';
}

function createCandidate(candidateId, clusterId) {
  return {
    candidateId,
    clusterId,
    hypothesisId: null,
    family: null,
    symbolKey: null,
    symbol: null,
    timeframe: null,
    direction: null,
    signalCandleOpenTime: null,
    signalCandleOpenAt: null,
    nominatedAt: null,
    entered: false,
    expired: false,
    entry: null,
    initialStop: null,
    riskDistance: null,
    targets: new Map(),
    legs: new Map(),
    firstObservedAt: null,
    lastObservedAt: null,
  };
}
function createCluster(clusterId) {
  return {
    clusterId,
    candidates: new Map(),
    memberHypothesisIds: new Set(),
    families: new Set(),
    symbolKeys: new Set(),
    symbols: new Set(),
    timeframes: new Set(),
    directions: new Set(),
    signalOpenTimes: new Set(),
    firstObservedAt: null,
    lastObservedAt: null,
    sourceFromByte: null,
    sourceToByte: null,
  };
}

class EvidenceStatisticalScoringEngine {
  constructor({ config, storage, persistQueue, now = () => Date.now(), log = () => {} }) {
    this.config = config;
    this.storage = storage;
    this.persistQueue = persistQueue;
    this.now = now;
    this.log = log;
    const dataRoot = path.resolve(config.dataRoot || process.cwd());
    this.scoring = {
      enabled: true,
      certifiedLedgerFile: path.join(dataRoot, 'evidence', 'crypto-forward-shadow-ledger-v12051.ndjson'),
      clusterOutcomesFile: path.join(dataRoot, 'evidence', 'scoring', 'cluster-outcomes.ndjson'),
      hypothesisScoresFile: path.join(dataRoot, 'evidence', 'scoring', 'hypothesis-scores.ndjson'),
      snapshotsFile: path.join(dataRoot, 'evidence', 'statistical-scoring-snapshots.ndjson'),
      stateFile: path.join(dataRoot, 'state', 'evidence-scoring-state.json'),
      ...(config.scoring || {}),
    };
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(this.scoring.thresholds || {}) };
    this.enabled = this.scoring.enabled !== false;
    this.state = this.emptyState();
    this.inFlight = false;
    this.pendingReason = null;
    this.runPromise = null;
  }

  emptyState() {
    return {
      schema: SCORING_SCHEMA,
      version: this.config.version,
      status: this.enabled ? 'READY_AWAITING_CERTIFIED_LEDGER' : 'DISABLED',
      enabled: this.enabled,
      mode: 'READ_ONLY_DETERMINISTIC_LEDGER_FOLD',
      sourceEvidenceClass: CERTIFIED_EVIDENCE_CLASS,
      certifiedOnly: true,
      provisionalExcluded: true,
      paperOnly: true,
      liveCapitalExecution: false,
      executionEnabled: false,
      promotionEnabled: false,
      rankingEnabled: false,
      candidateEngineMutation: false,
      v11Writes: 0,
      thresholds: { ...this.thresholds },
      lastSnapshotId: null,
      lastSnapshotAt: null,
      lastInputFingerprint: null,
      hypothesesScored: 0,
      clustersObserved: 0,
      independentEvaluatedClustersByLeg: { R1: 0, R2: 0, R5: 0 },
      byState: { POSITIVE_EVIDENCE: 0, NEGATIVE_EVIDENCE: 0, NOT_PROVEN: 0, INSUFFICIENT_EVIDENCE: 0 },
      diagnostics: {
        entryModelStarved: [],
        clusterMemberDivergence: [],
        conflictBySymbolTimeframe: [],
        ambiguityBySymbolTimeframeLeg: [],
        openTailByHypothesis: [],
      },
      latestScores: [],
      latestSnapshotSummary: null,
      clusterFingerprintById: {},
      scoreFingerprintByHypothesis: {},
      lastRunStartedAt: null,
      lastRunCompletedAt: null,
      lastRunDurationMs: null,
      lastRunReason: null,
      lastError: null,
      persistence: null,
    };
  }

  async init() {
    const prior = await this.storage.readJson(this.scoring.stateFile, null);
    const base = this.emptyState();
    if (prior && prior.schema === SCORING_SCHEMA) {
      this.state = {
        ...base,
        ...prior,
        version: this.config.version,
        enabled: this.enabled,
        thresholds: { ...this.thresholds },
        latestScores: Array.isArray(prior.latestScores) ? prior.latestScores : [],
        clusterFingerprintById: prior.clusterFingerprintById && typeof prior.clusterFingerprintById === 'object' ? prior.clusterFingerprintById : {},
        scoreFingerprintByHypothesis: prior.scoreFingerprintByHypothesis && typeof prior.scoreFingerprintByHypothesis === 'object' ? prior.scoreFingerprintByHypothesis : {},
      };
    }
    // Append-only recovery: if the state write was interrupted after a snapshot append,
    // recover the last committed snapshot id so identical ledger bytes are not appended twice.
    const snapshotTail = await this.storage.readNdjsonTail(this.scoring.snapshotsFile, 1, 512 * 1024).catch(() => []);
    const committedSnapshot = Array.isArray(snapshotTail) ? snapshotTail.at(-1) : null;
    if (committedSnapshot?.schema === SNAPSHOT_SCHEMA && committedSnapshot.snapshotId) {
      if (!this.state.lastSnapshotId || String(committedSnapshot.snapshotAt || '') >= String(this.state.lastSnapshotAt || '')) {
        this.state.lastSnapshotId = committedSnapshot.snapshotId;
        this.state.lastSnapshotAt = committedSnapshot.snapshotAt || this.state.lastSnapshotAt;
        this.state.lastInputFingerprint = committedSnapshot.inputFingerprint || this.state.lastInputFingerprint;
        this.state.latestSnapshotSummary = committedSnapshot;
      }
    }
    if (!this.enabled) this.state.status = 'DISABLED';
    return this.view();
  }

  async readCertifiedLedger() {
    const file = this.scoring.certifiedLedgerFile;
    const clusters = new Map();
    const candidates = new Map();
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let eventCount = 0;
    let certifiedEventCount = 0;
    let excludedEventCount = 0;
    let lastSequence = 0;
    let lastLedgerEventAt = null;
    let engineSchema = CERTIFIED_LEDGER_SCHEMA;
    let offset = 0;

    let input;
    try {
      const stat = await fsp.stat(file);
      bytes = Number(stat.size || 0);
      input = fs.createReadStream(file);
    } catch (_) {
      hash.update('');
      return {
        clusters, candidates,
        inputFingerprint: {
          ledgerSha256: hash.digest('hex'), ledgerBytes: 0, eventCount: 0, certifiedEventCount: 0,
          excludedEventCount: 0, lastSequence: 0, lastLedgerEventAt: null, engineSchema,
        },
      };
    }

    input.on('data', chunk => hash.update(chunk));
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      const fromByte = offset;
      offset += Buffer.byteLength(line, 'utf8') + 1;
      if (!line.trim()) continue;
      eventCount += 1;
      let event;
      try { event = JSON.parse(line); } catch (_) { excludedEventCount += 1; continue; }
      if (event.schema !== CERTIFIED_LEDGER_SCHEMA || event.evidenceClass !== CERTIFIED_EVIDENCE_CLASS) {
        excludedEventCount += 1;
        continue;
      }
      certifiedEventCount += 1;
      engineSchema = event.schema;
      lastSequence = Math.max(lastSequence, Number(event.sequence || 0));
      const observedAt = event.observedAt || event.at || null;
      if (observedAt && (!lastLedgerEventAt || String(observedAt) > String(lastLedgerEventAt))) lastLedgerEventAt = observedAt;
      this.foldEvent({ event, fromByte, toByte: Math.min(bytes, offset), clusters, candidates });
    }

    return {
      clusters, candidates,
      inputFingerprint: {
        ledgerSha256: hash.digest('hex'), ledgerBytes: bytes, eventCount, certifiedEventCount,
        excludedEventCount, lastSequence, lastLedgerEventAt, engineSchema,
      },
    };
  }

  foldEvent({ event, fromByte, toByte, clusters, candidates }) {
    const candidateId = event.candidateId ? String(event.candidateId) : null;
    const clusterId = event.evidenceClusterId ? String(event.evidenceClusterId) : (candidateId ? candidates.get(candidateId)?.clusterId : null);
    if (!candidateId || !clusterId) return;
    let cluster = clusters.get(clusterId);
    if (!cluster) { cluster = createCluster(clusterId); clusters.set(clusterId, cluster); }
    let candidate = candidates.get(candidateId);
    if (!candidate) { candidate = createCandidate(candidateId, clusterId); candidates.set(candidateId, candidate); cluster.candidates.set(candidateId, candidate); }
    if (!cluster.candidates.has(candidateId)) cluster.candidates.set(candidateId, candidate);

    const observedAt = event.observedAt || event.at || null;
    candidate.firstObservedAt = candidate.firstObservedAt || observedAt;
    candidate.lastObservedAt = observedAt || candidate.lastObservedAt;
    cluster.firstObservedAt = cluster.firstObservedAt || observedAt;
    cluster.lastObservedAt = observedAt || cluster.lastObservedAt;
    cluster.sourceFromByte = cluster.sourceFromByte == null ? fromByte : Math.min(cluster.sourceFromByte, fromByte);
    cluster.sourceToByte = cluster.sourceToByte == null ? toByte : Math.max(cluster.sourceToByte, toByte);

    if (event.hypothesisId) candidate.hypothesisId = String(event.hypothesisId);
    if (event.family) candidate.family = String(event.family);
    candidate.family = candidate.family || familyFromHypothesis(candidate.hypothesisId);
    candidate.symbolKey = candidate.symbolKey || symbolKeyFromEvent(event);
    candidate.symbol = candidate.symbol || event.symbol || null;
    candidate.timeframe = candidate.timeframe || event.timeframe || timeframeFromHypothesis(candidate.hypothesisId);
    candidate.direction = candidate.direction || event.direction || null;
    const signalOpenAt = event.signalCandleOpenAt || event.signalCandleAt || null;
    const signalOpenMs = finite(event.signalCandleOpenTime) ?? parseMs(signalOpenAt);
    if (signalOpenMs != null) candidate.signalCandleOpenTime = signalOpenMs;
    if (signalOpenAt) candidate.signalCandleOpenAt = signalOpenAt;
    if (event.nominatedAt) candidate.nominatedAt = event.nominatedAt;

    if (candidate.hypothesisId) cluster.memberHypothesisIds.add(candidate.hypothesisId);
    if (candidate.family) cluster.families.add(candidate.family);
    if (candidate.symbolKey) cluster.symbolKeys.add(candidate.symbolKey);
    if (candidate.symbol) cluster.symbols.add(candidate.symbol);
    if (candidate.timeframe) cluster.timeframes.add(candidate.timeframe);
    if (candidate.direction) cluster.directions.add(candidate.direction);
    if (candidate.signalCandleOpenTime != null) cluster.signalOpenTimes.add(candidate.signalCandleOpenTime);

    if (event.type === 'CANDIDATE_FORWARD_ENTRY_OPENED') {
      candidate.entered = true;
      candidate.expired = false;
      candidate.entry = finite(event.entry);
      candidate.initialStop = finite(event.initialStop);
      candidate.riskDistance = candidate.entry != null && candidate.initialStop != null ? Math.abs(candidate.entry - candidate.initialStop) : null;
      candidate.entryAt = event.paperEntryAt || event.entryCandleCloseAt || event.candleCloseAt || observedAt;
      candidate.entryObservedAt = observedAt;
      for (const target of Array.isArray(event.targets) ? event.targets : []) {
        const rr = Number(target.rr);
        if (RR_LEGS.includes(rr)) candidate.targets.set(rr, finite(target.target));
      }
      for (const rr of RR_LEGS) if (!candidate.legs.has(rr)) candidate.legs.set(rr, { rr, status: 'OPEN', resultR: null, exitPrice: null, closedAt: null });
    } else if (event.type === 'CANDIDATE_ENTRY_EXPIRED') {
      candidate.expired = true;
      candidate.expiryReason = event.reason || 'ENTRY_EXPIRED';
      candidate.expiredAt = event.candleCloseAt || observedAt;
    } else if (['LEG_TARGET_HIT', 'LEG_STOP_HIT', 'LEG_CLOSED_AMBIGUOUS'].includes(event.type)) {
      const rr = Number(event.rr);
      if (!RR_LEGS.includes(rr)) return;
      let status = 'AMBIGUOUS';
      if (event.type === 'LEG_TARGET_HIT') status = 'TARGET_HIT';
      if (event.type === 'LEG_STOP_HIT') status = 'STOP_HIT';
      candidate.legs.set(rr, {
        rr,
        status,
        resultR: status === 'AMBIGUOUS' ? null : finite(event.resultR),
        exitPrice: finite(event.exitPrice),
        closedAt: event.candleCloseAt || observedAt,
        closeReason: event.closeReason || event.type,
      });
    }
  }

  finalizeClusters(rawClusters, snapshotAt) {
    const clusters = [];
    for (const cluster of rawClusters.values()) {
      const members = [...cluster.candidates.values()].sort((a, b) => a.candidateId.localeCompare(b.candidateId));
      const divergenceReasons = [];
      if (cluster.symbolKeys.size > 1) divergenceReasons.push('SYMBOL_KEY_DIVERGENCE');
      if (cluster.timeframes.size > 1) divergenceReasons.push('TIMEFRAME_DIVERGENCE');
      if (cluster.directions.size > 1) divergenceReasons.push('DIRECTION_DIVERGENCE_WITHIN_CLUSTER');
      if (cluster.signalOpenTimes.size > 1) divergenceReasons.push('SIGNAL_CANDLE_DIVERGENCE');
      const enteredMembers = members.filter(m => m.entered);
      const expiredMembers = members.filter(m => m.expired);
      const entrySignatures = uniqueSorted(enteredMembers.map(canonicalEntrySignature));
      if (entrySignatures.length > 1) divergenceReasons.push('ENTRY_STOP_TARGET_DIVERGENCE');
      if (enteredMembers.length && expiredMembers.length) divergenceReasons.push('ENTRY_EXPIRY_DIVERGENCE');

      const legs = [];
      for (const rr of RR_LEGS) {
        const memberOutcomes = enteredMembers.map(member => ({ member, outcome: member.legs.get(rr) || { rr, status: 'OPEN', resultR: null, exitPrice: null, closedAt: null } }));
        const terminal = memberOutcomes.filter(row => ['TARGET_HIT', 'STOP_HIT', 'AMBIGUOUS'].includes(row.outcome.status));
        const signatures = uniqueSorted(terminal.map(row => canonicalTerminalSignature(row.outcome)));
        let status = 'NOT_ENTERED';
        let resultR = null;
        let exitPrice = null;
        let closedAt = null;
        let ambiguous = false;
        if (enteredMembers.length) {
          if (!terminal.length) status = 'OPEN';
          else if (terminal.length < enteredMembers.length) status = 'PARTIALLY_SETTLED';
          else if (signatures.length > 1) { status = 'DIVERGENT'; divergenceReasons.push(`R${rr}_OUTCOME_DIVERGENCE`); }
          else {
            const outcome = terminal[0].outcome;
            status = outcome.status;
            resultR = outcome.resultR;
            exitPrice = outcome.exitPrice;
            closedAt = outcome.closedAt;
            ambiguous = outcome.status === 'AMBIGUOUS';
          }
        }
        legs.push({ rr, status, resultR: resultR == null ? null : round(resultR, 8), exitPrice: exitPrice == null ? null : round(exitPrice), closedAt, ambiguous });
      }
      const symbolKey = uniqueSorted([...cluster.symbolKeys])[0] || null;
      const timeframe = uniqueSorted([...cluster.timeframes])[0] || null;
      const direction = uniqueSorted([...cluster.directions])[0] || null;
      const signalCandleOpenTime = uniqueSorted([...cluster.signalOpenTimes].map(String))[0];
      const signalMs = signalCandleOpenTime == null ? null : Number(signalCandleOpenTime);
      const intervalMs = frameIntervalMs(timeframe);
      const entryAtValues = enteredMembers.map(m => parseMs(m.entryAt)).filter(Number.isFinite);
      const entryAtMs = entryAtValues.length ? Math.min(...entryAtValues) : null;
      const openLegs = legs.filter(leg => ['OPEN', 'PARTIALLY_SETTLED'].includes(leg.status)).length;
      const openAgeCandles = entryAtMs == null || !openLegs ? null : Math.max(0, Math.floor((parseMs(snapshotAt) - entryAtMs) / intervalMs));
      const entered = enteredMembers.length > 0;
      const expired = !entered && expiredMembers.length > 0 && expiredMembers.length === members.length;
      const pending = !entered && !expired;
      const settled = entered && legs.every(leg => ['TARGET_HIT', 'STOP_HIT', 'AMBIGUOUS'].includes(leg.status));
      const settledTimes = legs.map(leg => parseMs(leg.closedAt)).filter(Number.isFinite);
      clusters.push({
        schema: CLUSTER_SCHEMA,
        clusterId: cluster.clusterId,
        conflictGroupId: null,
        symbolKey,
        symbol: uniqueSorted([...cluster.symbols])[0] || null,
        timeframe,
        direction,
        signalCandleOpenTime: signalMs,
        signalCandleOpenAt: signalMs == null ? null : iso(signalMs),
        memberCandidateIds: members.map(m => m.candidateId),
        memberHypothesisIds: uniqueSorted([...cluster.memberHypothesisIds]),
        memberAttribution: members.map(m => ({ candidateId: m.candidateId, hypothesisId: m.hypothesisId, family: m.family })),
        families: uniqueSorted([...cluster.families]),
        candidateMemberCount: members.length,
        entry: entrySignatures.length === 1 ? round(enteredMembers[0].entry) : null,
        initialStop: entrySignatures.length === 1 ? round(enteredMembers[0].initialStop) : null,
        riskDistance: entrySignatures.length === 1 ? round(enteredMembers[0].riskDistance) : null,
        legs,
        entered,
        expired,
        pending,
        settled,
        openLegs,
        openAgeCandles,
        divergence: divergenceReasons.length > 0,
        divergenceReasons: uniqueSorted(divergenceReasons),
        firstObservedAt: cluster.firstObservedAt,
        lastObservedAt: cluster.lastObservedAt,
        settledAt: settledTimes.length ? iso(Math.max(...settledTimes)) : null,
        sourceLedgerOffsets: { fromByte: cluster.sourceFromByte, toByte: cluster.sourceToByte },
        certifiedOnly: true,
        provisionalExcluded: true,
        paperOnly: true,
      });
    }

    const groups = new Map();
    for (const cluster of clusters) {
      if (!cluster.symbolKey || !cluster.timeframe || cluster.signalCandleOpenTime == null || !cluster.direction) continue;
      const key = `${cluster.symbolKey}|${cluster.timeframe}|${cluster.signalCandleOpenTime}`;
      let group = groups.get(key);
      if (!group) { group = { key, directions: new Set(), clusters: [] }; groups.set(key, group); }
      group.directions.add(cluster.direction);
      group.clusters.push(cluster);
    }
    for (const group of groups.values()) {
      if (group.directions.size < 2) continue;
      const id = conflictGroupId(...group.key.split('|'));
      for (const cluster of group.clusters) {
        cluster.conflictGroupId = id;
        cluster.conflict = true;
      }
    }
    for (const cluster of clusters) if (!cluster.conflict) cluster.conflict = false;
    return clusters.sort((a, b) => a.clusterId.localeCompare(b.clusterId));
  }

  buildScores(clusters, snapshotId, snapshotAt, inputFingerprint) {
    const rows = new Map();
    const ensure = (hypothesisId, cluster) => {
      let row = rows.get(hypothesisId);
      if (!row) {
        row = {
          hypothesisId,
          symbolKey: cluster.symbolKey,
          timeframe: cluster.timeframe,
          family: familyFromHypothesis(hypothesisId) || cluster.families[0] || null,
          clusters: [],
          candidateMembers: 0,
          legValues: { R1: [], R2: [], R5: [] },
          legAmbiguous: { R1: 0, R2: 0, R5: 0 },
          legOpen: { R1: 0, R2: 0, R5: 0 },
          legOpenAges: { R1: [], R2: [], R5: [] },
        };
        rows.set(hypothesisId, row);
      }
      return row;
    };

    for (const cluster of clusters) {
      for (const hypothesisId of cluster.memberHypothesisIds) {
        const row = ensure(hypothesisId, cluster);
        row.clusters.push(cluster);
        // Count only members attributed to this hypothesis. Other family members in the
        // same economic cluster are retained for attribution but must not inflate this row.
        row.candidateMembers += cluster.memberAttribution.filter(member => member.hypothesisId === hypothesisId).length;
        for (const leg of cluster.legs) {
          const key = `R${leg.rr}`;
          if (cluster.divergence) continue;
          if (['TARGET_HIT', 'STOP_HIT'].includes(leg.status) && Number.isFinite(leg.resultR)) row.legValues[key].push(leg.resultR);
          else if (leg.status === 'AMBIGUOUS') row.legAmbiguous[key] += 1;
          else if (['OPEN', 'PARTIALLY_SETTLED'].includes(leg.status)) {
            row.legOpen[key] += 1;
            if (Number.isFinite(cluster.openAgeCandles)) row.legOpenAges[key].push(cluster.openAgeCandles);
          }
        }
      }
    }

    const scores = [];
    for (const row of [...rows.values()].sort((a, b) => a.hypothesisId.localeCompare(b.hypothesisId))) {
      const nominations = row.clusters.length;
      const entries = row.clusters.filter(c => c.entered).length;
      const expired = row.clusters.filter(c => c.expired).length;
      const pending = row.clusters.filter(c => c.pending).length;
      const conflictClusters = row.clusters.filter(c => c.conflict).length;
      const divergentClusters = row.clusters.filter(c => c.divergence).length;
      const perLeg = {};
      let ambiguousLegs = 0;
      let resolvedLegs = 0;
      const allOpenAges = [];
      for (const rr of RR_LEGS) {
        const key = `R${rr}`;
        const values = row.legValues[key];
        const wins = values.filter(v => v > 0).length;
        const losses = values.filter(v => v < 0).length;
        const breakevens = values.filter(v => v === 0).length;
        const netR = values.reduce((sum, v) => sum + v, 0);
        const meanCi = meanConfidence95(values);
        const wilson = wilsonInterval(wins, values.length, this.thresholds.z);
        const ambiguous = row.legAmbiguous[key];
        const open = row.legOpen[key];
        ambiguousLegs += ambiguous;
        resolvedLegs += values.length + ambiguous;
        allOpenAges.push(...row.legOpenAges[key]);
        const stats = {
          rr,
          n: values.length,
          wins,
          losses,
          breakevens,
          netR: round(netR, 8),
          realizedNetR: round(netR, 8),
          meanR: meanCi.mean,
          stdR: meanCi.std,
          meanR_LB95: meanCi.lower,
          meanR_UB95: meanCi.upper,
          meanRLower95: meanCi.lower,
          meanRUpper95: meanCi.upper,
          tCritical95: meanCi.tCritical,
          winRate: wilson.rate,
          winRateLB95: wilson.lower,
          winRateUB95: wilson.upper,
          wilsonWinRateLower95: wilson.lower,
          wilsonWinRateUpper95: wilson.upper,
          naiveBreakevenWinRate: round(1 / (1 + rr), 8),
          ambiguousClusters: ambiguous,
          ambiguousRate: values.length + ambiguous ? round(ambiguous / (values.length + ambiguous), 8) : null,
          openClusters: open,
          openR: null,
          openRStatus: 'NOT_MARKED_TO_MARKET_BY_READ_ONLY_SCORER',
          openTailAgeP50Candles: percentile(row.legOpenAges[key], 0.50),
          openTailAgeP90Candles: percentile(row.legOpenAges[key], 0.90),
        };
        stats.evidenceState = evidenceState(stats, this.thresholds);
        perLeg[key] = stats;
      }
      const primary = perLeg[this.thresholds.primaryLeg];
      const score = {
        schema: SCORE_SCHEMA,
        version: this.config.version,
        snapshotId,
        snapshotAt,
        inputFingerprint,
        hypothesisId: row.hypothesisId,
        symbolKey: row.symbolKey,
        timeframe: row.timeframe,
        family: row.family,
        observationUnit: 'EVIDENCE_CLUSTER_WEIGHT_1',
        funnel: {
          nominations,
          entries,
          expired,
          pending,
          entryRate: nominations ? round(entries / nominations, 8) : null,
          expiryRate: nominations ? round(expired / nominations, 8) : null,
          scoredClusterLegs: resolvedLegs - ambiguousLegs,
          ambiguousClusterLegs: ambiguousLegs,
          ambiguousRate: resolvedLegs ? round(ambiguousLegs / resolvedLegs, 8) : null,
          conflictClusters,
          conflictRate: nominations ? round(conflictClusters / nominations, 8) : null,
          divergentClusters,
          openClusters: row.clusters.filter(c => c.entered && c.openLegs > 0).length,
          openLegs: RR_LEGS.reduce((sum, rr) => sum + row.legOpen[`R${rr}`], 0),
          openTailAgeP50Candles: percentile(allOpenAges, 0.50),
          openTailAgeP90Candles: percentile(allOpenAges, 0.90),
          realizedRSeparatedFromOpen: true,
        },
        perLeg,
        primaryLeg: this.thresholds.primaryLeg,
        compositeEvidenceState: primary?.evidenceState || 'INSUFFICIENT_EVIDENCE',
        compositeMeanRLower95: primary?.meanRLower95 ?? null,
        compositeWilsonWinRateLower95: primary?.wilsonWinRateLower95 ?? null,
        evaluatedClusterCount: primary?.n || 0,
        candidateMemberCount: row.candidateMembers,
        independentClusterCount: nominations,
        clusterIds: row.clusters.map(c => c.clusterId).sort(),
        thresholds: { ...this.thresholds },
        judgmentEligible: (primary?.n || 0) >= this.thresholds.minScoredClusters,
        rankingEligible: false,
        promotionEligible: false,
        certifiedOnly: true,
        provisionalExcluded: true,
        paperOnly: true,
        liveCapitalExecution: false,
      };
      scores.push(score);
    }
    return scores;
  }

  buildDiagnostics(clusters, scores) {
    const entryModelStarved = scores.filter(score => score.funnel.nominations >= this.thresholds.entryModelStarvedMinNominations && Number(score.funnel.expiryRate || 0) >= this.thresholds.entryModelStarvedRate)
      .map(score => ({ hypothesisId: score.hypothesisId, nominations: score.funnel.nominations, expiryRate: score.funnel.expiryRate, flag: 'ENTRY_MODEL_STARVED' }));
    const clusterMemberDivergence = clusters.filter(c => c.divergence).map(c => ({ clusterId: c.clusterId, reasons: c.divergenceReasons, memberCandidateIds: c.memberCandidateIds }));

    const conflictMap = new Map();
    const ambiguityMap = new Map();
    for (const cluster of clusters) {
      const st = `${cluster.symbolKey}|${cluster.timeframe}`;
      let conflict = conflictMap.get(st);
      if (!conflict) { conflict = { symbolKey: cluster.symbolKey, timeframe: cluster.timeframe, clusters: 0, conflictClusters: 0, conflictGroups: new Set() }; conflictMap.set(st, conflict); }
      conflict.clusters += 1;
      if (cluster.conflict) { conflict.conflictClusters += 1; conflict.conflictGroups.add(cluster.conflictGroupId); }
      for (const leg of cluster.legs) {
        const key = `${st}|R${leg.rr}`;
        let a = ambiguityMap.get(key);
        if (!a) { a = { symbolKey: cluster.symbolKey, timeframe: cluster.timeframe, leg: `R${leg.rr}`, resolved: 0, ambiguous: 0 }; ambiguityMap.set(key, a); }
        if (['TARGET_HIT', 'STOP_HIT', 'AMBIGUOUS'].includes(leg.status)) a.resolved += 1;
        if (leg.status === 'AMBIGUOUS') a.ambiguous += 1;
      }
    }
    const conflictBySymbolTimeframe = [...conflictMap.values()].map(row => ({
      symbolKey: row.symbolKey,
      timeframe: row.timeframe,
      clusters: row.clusters,
      conflictClusters: row.conflictClusters,
      conflictGroups: row.conflictGroups.size,
      conflictRate: row.clusters ? round(row.conflictClusters / row.clusters, 8) : null,
      diagnosticOnly: true,
      thresholdFrozen: false,
    })).sort((a, b) => `${a.symbolKey}|${a.timeframe}`.localeCompare(`${b.symbolKey}|${b.timeframe}`));
    const ambiguityBySymbolTimeframeLeg = [...ambiguityMap.values()].map(row => ({
      ...row,
      ambiguousRate: row.resolved ? round(row.ambiguous / row.resolved, 8) : null,
      diagnosticOnly: true,
      thresholdFrozen: false,
    })).sort((a, b) => `${a.symbolKey}|${a.timeframe}|${a.leg}`.localeCompare(`${b.symbolKey}|${b.timeframe}|${b.leg}`));
    const openTailByHypothesis = scores.filter(score => score.funnel.openLegs > 0).map(score => ({
      hypothesisId: score.hypothesisId,
      openClusters: score.funnel.openClusters,
      openLegs: score.funnel.openLegs,
      p50Candles: score.funnel.openTailAgeP50Candles,
      p90Candles: score.funnel.openTailAgeP90Candles,
      diagnosticOnly: true,
      thresholdFrozen: false,
    }));
    return { entryModelStarved, clusterMemberDivergence, conflictBySymbolTimeframe, ambiguityBySymbolTimeframeLeg, openTailByHypothesis };
  }

  buildSnapshot(fold) {
    const inputFingerprint = fold.inputFingerprint;
    const snapshotAt = inputFingerprint.lastLedgerEventAt || '1970-01-01T00:00:00.000Z';
    const snapshotId = `ES6-${stableHash({ schema: SNAPSHOT_SCHEMA, inputFingerprint, thresholds: this.thresholds, certifiedOnly: true }).slice(0, 32)}`;
    const clusters = this.finalizeClusters(fold.clusters, snapshotAt);
    const scores = this.buildScores(clusters, snapshotId, snapshotAt, inputFingerprint);
    const diagnostics = this.buildDiagnostics(clusters, scores);
    const byState = { POSITIVE_EVIDENCE: 0, NEGATIVE_EVIDENCE: 0, NOT_PROVEN: 0, INSUFFICIENT_EVIDENCE: 0 };
    for (const score of scores) byState[score.compositeEvidenceState] = Number(byState[score.compositeEvidenceState] || 0) + 1;
    const independentEvaluatedClustersByLeg = {};
    for (const rr of RR_LEGS) independentEvaluatedClustersByLeg[`R${rr}`] = clusters.filter(c => !c.divergence && ['TARGET_HIT', 'STOP_HIT'].includes(c.legs.find(l => l.rr === rr)?.status)).length;
    const summary = {
      schema: SNAPSHOT_SCHEMA,
      version: this.config.version,
      snapshotId,
      snapshotAt,
      inputFingerprint,
      thresholds: { ...this.thresholds },
      observationUnit: 'EVIDENCE_CLUSTER_WEIGHT_1',
      clustersObserved: clusters.length,
      enteredClusters: clusters.filter(c => c.entered).length,
      expiredClusters: clusters.filter(c => c.expired).length,
      pendingClusters: clusters.filter(c => c.pending).length,
      divergentClusters: clusters.filter(c => c.divergence).length,
      conflictClusters: clusters.filter(c => c.conflict).length,
      hypothesesScored: scores.length,
      independentEvaluatedClustersByLeg,
      byState,
      entryModelStarvedCount: diagnostics.entryModelStarved.length,
      certifiedOnly: true,
      provisionalExcluded: true,
      realizedRSeparatedFromOpen: true,
      paperOnly: true,
      liveCapitalExecution: false,
      promotionEnabled: false,
      rankingEnabled: false,
    };
    return { snapshotId, snapshotAt, inputFingerprint, clusters, scores, diagnostics, byState, independentEvaluatedClustersByLeg, summary };
  }

  async appendRows(file, rows) {
    if (!rows.length) return { ok: true, skipped: true };
    const lines = rows.map(stableStringify);
    const { done } = this.persistQueue.enqueueAppend(file, lines, { durable: true });
    const result = await done;
    if (!result?.ok) throw new Error(`APPEND_PERSISTENCE_FAILED:${file}:${result?.error || 'unknown'}`);
    return result;
  }

  async persistState() {
    this.state.persistence = {
      state: this.persistQueue.view(this.scoring.stateFile),
      clusterOutcomes: this.persistQueue.viewAppend(this.scoring.clusterOutcomesFile),
      hypothesisScores: this.persistQueue.viewAppend(this.scoring.hypothesisScoresFile),
      snapshots: this.persistQueue.viewAppend(this.scoring.snapshotsFile),
    };
    const { done } = this.persistQueue.enqueue(this.scoring.stateFile, this.state, { durable: true });
    const result = await done;
    if (!result?.ok) throw new Error(`SCORING_STATE_PERSISTENCE_FAILED:${result?.error || 'unknown'}`);
  }

  async run(reason = 'manual') {
    if (!this.enabled) return this.view();
    if (this.inFlight) { this.pendingReason = reason; return this.runPromise; }
    this.inFlight = true;
    const started = this.now();
    this.state.lastRunStartedAt = iso(started);
    this.state.lastRunReason = reason;
    this.state.lastError = null;
    this.state.status = 'SCORING_CERTIFIED_LEDGER';
    this.runPromise = (async () => {
      try {
        const fold = await this.readCertifiedLedger();
        const snapshot = this.buildSnapshot(fold);
        if (this.state.lastSnapshotId !== snapshot.snapshotId) {
          const changedClusters = [];
          const nextClusterFingerprints = { ...(this.state.clusterFingerprintById || {}) };
          for (const cluster of snapshot.clusters) {
            const row = { ...cluster, version: this.config.version, snapshotId: snapshot.snapshotId, snapshotAt: snapshot.snapshotAt };
            const fingerprint = stableHash(row);
            if (nextClusterFingerprints[cluster.clusterId] !== fingerprint) changedClusters.push(row);
            nextClusterFingerprints[cluster.clusterId] = fingerprint;
          }
          const changedScores = [];
          const nextScoreFingerprints = { ...(this.state.scoreFingerprintByHypothesis || {}) };
          for (const score of snapshot.scores) {
            const fingerprint = stableHash(score);
            if (nextScoreFingerprints[score.hypothesisId] !== fingerprint) changedScores.push(score);
            nextScoreFingerprints[score.hypothesisId] = fingerprint;
          }
          await this.appendRows(this.scoring.clusterOutcomesFile, changedClusters);
          await this.appendRows(this.scoring.hypothesisScoresFile, changedScores);
          await this.appendRows(this.scoring.snapshotsFile, [snapshot.summary]);
          this.state.clusterFingerprintById = nextClusterFingerprints;
          this.state.scoreFingerprintByHypothesis = nextScoreFingerprints;
        }
        this.state.status = 'EVIDENCE_SCORING_ACTIVE_INSUFFICIENT_EVIDENCE_GUARD';
        this.state.lastSnapshotId = snapshot.snapshotId;
        this.state.lastSnapshotAt = snapshot.snapshotAt;
        this.state.lastInputFingerprint = snapshot.inputFingerprint;
        this.state.hypothesesScored = snapshot.scores.length;
        this.state.clustersObserved = snapshot.clusters.length;
        this.state.independentEvaluatedClustersByLeg = snapshot.independentEvaluatedClustersByLeg;
        this.state.byState = snapshot.byState;
        this.state.diagnostics = snapshot.diagnostics;
        this.state.latestScores = snapshot.scores;
        this.state.latestSnapshotSummary = snapshot.summary;
        this.state.lastRunCompletedAt = iso(this.now());
        this.state.lastRunDurationMs = Math.max(0, this.now() - started);
        await this.persistState();
        return this.view();
      } catch (error) {
        this.state.status = 'EVIDENCE_SCORING_FAILED';
        this.state.lastError = String(error?.stack || error).slice(0, 2400);
        this.state.lastRunCompletedAt = iso(this.now());
        this.state.lastRunDurationMs = Math.max(0, this.now() - started);
        try { await this.persistState(); } catch (_) {}
        throw error;
      } finally {
        this.inFlight = false;
        this.runPromise = null;
        const pending = this.pendingReason;
        this.pendingReason = null;
        if (pending) setImmediate(() => this.schedule(pending));
      }
    })();
    return this.runPromise;
  }

  schedule(reason = 'candidate-cycle-complete') {
    if (!this.enabled) return;
    if (this.inFlight) { this.pendingReason = reason; return; }
    setImmediate(() => this.run(reason).catch(error => this.log('[v12.0.6] evidence scoring failed', error?.stack || error)));
  }

  async stop() {
    if (this.runPromise) await this.runPromise.catch(() => {});
    await this.persistQueue.flush(5000);
  }

  view() {
    const { clusterFingerprintById, scoreFingerprintByHypothesis, ...publicState } = this.state;
    return {
      ...publicState,
      generatedAt: iso(this.now()),
      inFlight: this.inFlight,
      pendingRun: Boolean(this.pendingReason),
      clusterFingerprintCount: Object.keys(clusterFingerprintById || {}).length,
      scoreFingerprintCount: Object.keys(scoreFingerprintByHypothesis || {}).length,
    };
  }

  hypothesesView() {
    return {
      schema: 'alps.gen2.hypothesisEvidenceScoresView.v1206',
      version: this.config.version,
      generatedAt: iso(this.now()),
      snapshotId: this.state.lastSnapshotId,
      snapshotAt: this.state.lastSnapshotAt,
      thresholds: { ...this.thresholds },
      rankingEnabled: false,
      promotionEnabled: false,
      scores: this.state.latestScores || [],
    };
  }

  diagnosticsView() {
    return {
      schema: 'alps.gen2.evidenceScoringDiagnostics.v1206',
      version: this.config.version,
      generatedAt: iso(this.now()),
      snapshotId: this.state.lastSnapshotId,
      snapshotAt: this.state.lastSnapshotAt,
      thresholds: { ...this.thresholds },
      diagnostics: this.state.diagnostics,
      diagnosticActionsAutomatic: false,
      enginePolicyMutation: false,
    };
  }

  async snapshotsTail(limit = 100) {
    return this.storage.readNdjsonTail(this.scoring.snapshotsFile, Math.max(1, Math.min(1000, Number(limit) || 100)), 4 * 1024 * 1024);
  }

  problems() {
    const rows = [];
    if (this.state.lastError) rows.push({ priority: 'P1', market: 'CRYPTO', code: 'EVIDENCE_SCORING_FAILED', error: this.state.lastError, status: 'OPEN' });
    for (const flag of this.state.diagnostics?.entryModelStarved || []) rows.push({ priority: 'P2', market: 'CRYPTO', code: 'ENTRY_MODEL_STARVED', ...flag, diagnosticOnly: true, enginePolicyChanged: false, status: 'OPEN' });
    for (const issue of this.state.diagnostics?.clusterMemberDivergence || []) rows.push({ priority: 'P1', market: 'CRYPTO', code: 'CLUSTER_MEMBER_DIVERGENCE', ...issue, status: 'OPEN' });
    rows.push({
      priority: 'INFO', market: 'CRYPTO', code: 'EVIDENCE_STATISTICAL_SCORING_ACTIVE',
      snapshotId: this.state.lastSnapshotId, clustersObserved: this.state.clustersObserved,
      hypothesesScored: this.state.hypothesesScored, minScoredClusters: this.thresholds.minScoredClusters,
      confidenceLevel: this.thresholds.confidenceLevel, primaryLeg: this.thresholds.primaryLeg,
      rankingEnabled: false, promotionEnabled: false, status: 'EXPECTED',
    });
    return rows;
  }
}

module.exports = {
  EvidenceStatisticalScoringEngine,
  DEFAULT_THRESHOLDS,
  SCORING_SCHEMA,
  CLUSTER_SCHEMA,
  SCORE_SCHEMA,
  SNAPSHOT_SCHEMA,
  CERTIFIED_EVIDENCE_CLASS,
  CERTIFIED_LEDGER_SCHEMA,
  stableStringify,
  stableHash,
  studentTCritical95,
  meanConfidence95,
  wilsonInterval,
  evidenceState,
};
