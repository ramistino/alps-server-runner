'use strict';

const { asArray, asObject, finite, text } = require('./utils');

function fmt(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildWarnings(state, acceptance) {
  const warnings = [];
  for (const [name, gate] of Object.entries(asObject(state.gates))) {
    if (name === 'overall') continue;
    if (!gate || gate.pass === true) continue;
    warnings.push({
      type: 'GATE',
      key: name,
      status: text(gate && gate.status, 'WARN'),
      message: `Gate ${name} is not passing`,
    });
  }
  for (const [name, layer] of Object.entries(asObject(state.layers))) {
    if (!layer || layer.fresh === true) continue;
    warnings.push({
      type: 'LAYER',
      key: name,
      status: text(layer && layer.status, 'WARN'),
      message: `Layer ${name} is ${text(layer && layer.status, 'not ready')}`,
    });
  }
  for (const name of asArray(acceptance && acceptance.staleOrNotReady)) {
    if (!warnings.some(row => row.key === name)) {
      warnings.push({ type: 'ACCEPTANCE', key: name, status: 'WARN', message: `${name} is stale or not ready` });
    }
  }
  return warnings;
}

function buildDashboardModel(orchestrator, config, reason = 'dashboard-data') {
  const state = orchestrator.snapshot(reason);
  const acceptance = orchestrator.operationalAcceptance();
  const metrics = asObject(state.metrics);
  const family = asObject(state.familyAdjustedStats || metrics.familyAdjustedStats);
  const raw = asObject(metrics.rawLedgerStats);
  const learning = asObject(state.learning);
  const autonomy = asObject(state.autonomyAuthority);
  const cohort = asObject(state.candidateCohort);
  const accounting = asObject(state.candidateAccounting);
  const feature = asObject(state.serverFeatures);
  const runtime = asObject(state.runtime);

  return {
    schema: 'alps.v10200.dashboardData.v1',
    version: config.version,
    dashboardVersion: 'v10.2.0-live-monitor-and-report-authority',
    generatedAt: state.generatedAt || new Date().toISOString(),
    sourceOfTruth: 'CURRENT_V102_OPERATIONAL_STATE',
    status: text(state.status, 'UNKNOWN'),
    labRunning: Boolean(state.labRunning),
    researchReady: Boolean(state.researchReady),
    paperLifecycleRunning: Boolean(state.paperLifecycleRunning),
    execution: state.execution || { paperOnly: true, liveCapitalExecution: false, testnetExecution: false },
    acceptance: {
      pass: Boolean(acceptance && acceptance.pass),
      status: text(acceptance && acceptance.status, 'UNKNOWN'),
      staleOrNotReady: asArray(acceptance && acceptance.staleOrNotReady),
      nextRequiredAction: text(acceptance && acceptance.nextRequiredAction, text(state.gates && state.gates.overall && state.gates.overall.nextRequiredAction, 'OBSERVE')),
    },
    gates: asObject(state.gates),
    layers: asObject(state.layers),
    metrics: {
      candidates: finite(metrics.candidates, 0),
      nativePoolCandidates: finite(metrics.nativePoolCandidates, 0),
      forwardLatchSize: finite(metrics.forwardLatchSize, 0),
      paperVisibilitySeen: finite(metrics.paperVisibilitySeen, 0),
      pendingEntries: finite(metrics.pendingEntries, 0),
      openPositions: finite(metrics.openPositions, 0),
      closedTrades: finite(metrics.rawClosedTrades, 0),
      featureRowsFound: finite(metrics.featureRowsFound, 0),
      freshFeaturePairFrames: finite(metrics.freshFeaturePairFrames, 0),
      requiredFeaturePairFrames: finite(metrics.requiredFeaturePairFrames, 35),
    },
    performance: {
      familyAdjusted: {
        source: text(family.source, 'NOT_AVAILABLE'),
        independentFamilies: finite(family.independentFamilies, finite(learning.independentExperimentFamilies, 0)),
        wins: finite(family.wins, 0),
        losses: finite(family.losses, 0),
        breakeven: finite(family.breakeven, 0),
        winRate: finite(family.winRate, 0),
        profitFactorR: family.profitFactorR ?? null,
        avgResultR: family.avgResultR ?? null,
      },
      rawLedgerAudit: {
        closedTrades: finite(raw.closedTrades, finite(metrics.rawClosedTrades, 0)),
        wins: finite(raw.wins, 0),
        losses: finite(raw.losses, 0),
        breakeven: finite(raw.breakeven, 0),
        winRate: finite(raw.winRate, 0),
        profitFactorR: raw.profitFactorR ?? null,
      },
    },
    featureAuthority: {
      status: text(feature.status, text(state.layers && state.layers.featureEngine && state.layers.featureEngine.coverageStatus, 'UNKNOWN')),
      ready: Boolean(feature.ready || (state.layers && state.layers.featureEngine && state.layers.featureEngine.ready)),
      found: finite(feature.featureRowsFound, finite(metrics.featureRowsFound, 0)),
      fresh: finite(feature.freshFeaturePairFrames, finite(metrics.freshFeaturePairFrames, 0)),
      required: finite(feature.requiredPairFrames, finite(metrics.requiredFeaturePairFrames, 35)),
      lastRefreshCompletedAt: feature.lastRefreshCompletedAt || null,
      sources: asObject(feature.sourceCounts),
    },
    learning: {
      status: text(learning.status, 'NOT_READY'),
      independentFamilies: finite(learning.independentExperimentFamilies, 0),
      actions: asArray(learning.actions || learning.learningActions),
      pairConfidence: asArray(learning.pairConfidence),
      timeframeConfidence: asArray(learning.timeframeConfidence),
      appliedToCandidatePriority: Boolean(learning.appliedToCandidatePriority),
      appliedAsHardFilter: Boolean(learning.appliedAsHardFilter || learning.appliedToExecutionAsHardFilter),
    },
    autonomy: {
      status: text(autonomy.status, text(state.gates && state.gates.autonomy && state.gates.autonomy.status, 'UNKNOWN')),
      active: Boolean(autonomy.active),
      pass: Boolean(autonomy.pass || (state.gates && state.gates.autonomy && state.gates.autonomy.pass)),
      engineHookActive: Boolean(autonomy.engineHookActive),
      nativePoolOverrideApplied: Boolean(autonomy.nativePoolOverrideApplied),
      noFixedCandidateCap: autonomy.noFixedCandidateCap !== false,
      noHardLearningBans: autonomy.noHardLearningBans !== false,
      eligible: finite(autonomy.eligible, 0),
      forwardedToLatch: finite(autonomy.forwardedToLatch, 0),
      blocked: finite(autonomy.blocked, 0),
    },
    candidateCohort: {
      status: text(cohort.status, 'NOT_AVAILABLE'),
      cohortId: text(cohort.cohortId || cohort.authorityEpoch),
      persistentGapConfirmed: Boolean(cohort.persistentGapConfirmed),
      transientGap: finite(cohort.transientGap, finite(cohort.discoveryToLatchGap, 0)),
      observationCount: finite(cohort.observationCount, 0),
      candidates: finite(cohort.candidates, finite(metrics.candidates, 0)),
      nativePool: finite(cohort.nativePool, finite(metrics.nativePoolCandidates, 0)),
      latch: finite(cohort.forwardLatch || cohort.latch, finite(metrics.forwardLatchSize, 0)),
      paperVisibilityStatus: text(accounting.transitions && accounting.transitions.paperVisibilityStatus, 'OBSERVATIONAL'),
      paperVisibilityObservationDelta: finite(accounting.transitions && accounting.transitions.paperVisibilityObservationDelta, 0),
    },
    lifecycle: asObject(state.lifecycle),
    runtime: {
      fast: asObject(runtime.fast),
      heavy: asObject(runtime.heavy),
      recovery: asObject(runtime.recovery),
      supervisor: asObject(runtime.supervisor),
      architecture: text(runtime.architecture),
    },
    adapter: asObject(state.adapter),
    warnings: buildWarnings(state, acceptance),
    reportUrls: {
      json: '/runner/report.json',
      markdown: '/runner/report.md',
      csv: '/runner/report.csv',
      html: '/runner/report.html',
      manifest: '/runner/reports',
    },
    endpoints: {
      dashboard: '/',
      live: '/runner/live',
      acceptance: '/runner/acceptance',
      chart: '/runner/chart',
      learning: '/runner/learning',
      autonomy: '/runner/autonomy',
      candidateCohort: '/runner/candidate-cohort',
      ledgerStats: '/runner/ledger-stats',
    },
  };
}

function markdownTable(headers, rows) {
  const clean = value => String(value ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `| ${headers.map(clean).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(clean).join(' | ')} |`),
  ].join('\n');
}

function toMarkdown(model) {
  const gateRows = Object.entries(asObject(model.gates)).map(([name, gate]) => [name, gate && gate.status, gate && gate.pass ? 'PASS' : 'WARN']);
  const layerRows = Object.entries(asObject(model.layers)).map(([name, layer]) => [name, layer && layer.status, layer && layer.fresh ? 'YES' : 'NO', layer && layer.ageSec]);
  const pairRows = asArray(model.learning.pairConfidence).map(row => [row.key, row.closed, row.wins, row.losses, row.confidenceScore, row.status]);
  const tfRows = asArray(model.learning.timeframeConfidence).map(row => [row.key, row.closed, row.wins, row.losses, row.confidenceScore, row.status]);
  const actionRows = asArray(model.learning.actions).map(row => [row.action, row.target, row.reason]);
  return `# ALPS Operational Truth Report\n\n` +
    `- Generated At: ${model.generatedAt}\n` +
    `- Version: ${model.version}\n` +
    `- Source of Truth: ${model.sourceOfTruth}\n` +
    `- Overall Status: ${model.acceptance.status}\n` +
    `- Lab Running: ${model.labRunning}\n` +
    `- Research Ready: ${model.researchReady}\n` +
    `- Paper Lifecycle Running: ${model.paperLifecycleRunning}\n` +
    `- Next Required Action: ${model.acceptance.nextRequiredAction}\n\n` +
    `## Safety\n\n` +
    `- Paper Only: ${model.execution.paperOnly}\n` +
    `- Live Capital Execution: ${model.execution.liveCapitalExecution}\n` +
    `- Testnet Execution: ${model.execution.testnetExecution}\n\n` +
    `## Core Metrics\n\n` +
    markdownTable(['Metric','Value'], [
      ['Candidates', fmt(model.metrics.candidates, 0)],
      ['Native Pool', fmt(model.metrics.nativePoolCandidates, 0)],
      ['Forward Latch', fmt(model.metrics.forwardLatchSize, 0)],
      ['Paper Visibility Seen', fmt(model.metrics.paperVisibilitySeen, 0)],
      ['Pending Entries', fmt(model.metrics.pendingEntries, 0)],
      ['Open Positions', fmt(model.metrics.openPositions, 0)],
      ['Closed Trades', fmt(model.metrics.closedTrades, 0)],
      ['Feature Coverage', `${model.metrics.freshFeaturePairFrames}/${model.metrics.requiredFeaturePairFrames}`],
    ]) + `\n\n` +
    `## Gates\n\n${markdownTable(['Gate','Status','Pass'], gateRows)}\n\n` +
    `## Layer Freshness\n\n${markdownTable(['Layer','Status','Fresh','Age Sec'], layerRows)}\n\n` +
    `## Family-Adjusted Performance Authority\n\n` +
    markdownTable(['Metric','Value'], [
      ['Authority', model.performance.familyAdjusted.source],
      ['Independent Families', fmt(model.performance.familyAdjusted.independentFamilies, 0)],
      ['Wins', fmt(model.performance.familyAdjusted.wins, 0)],
      ['Losses', fmt(model.performance.familyAdjusted.losses, 0)],
      ['Breakeven', fmt(model.performance.familyAdjusted.breakeven, 0)],
      ['Win Rate', `${fmt(model.performance.familyAdjusted.winRate)}%`],
      ['Profit Factor R', fmt(model.performance.familyAdjusted.profitFactorR, 4)],
      ['Average Result R', fmt(model.performance.familyAdjusted.avgResultR, 4)],
    ]) + `\n\n` +
    `## Candidate Cohort\n\n` +
    markdownTable(['Metric','Value'], [
      ['Status', model.candidateCohort.status],
      ['Cohort ID', model.candidateCohort.cohortId || '—'],
      ['Persistent Gap Confirmed', model.candidateCohort.persistentGapConfirmed],
      ['Transient Gap', model.candidateCohort.transientGap],
      ['Paper Visibility Semantics', model.candidateCohort.paperVisibilityStatus],
      ['Paper Visibility Observation Delta', model.candidateCohort.paperVisibilityObservationDelta],
    ]) + `\n\n` +
    `## Full Autonomy\n\n` +
    markdownTable(['Metric','Value'], [
      ['Status', model.autonomy.status],
      ['Active', model.autonomy.active],
      ['Engine Hook Active', model.autonomy.engineHookActive],
      ['Native Pool Override Applied', model.autonomy.nativePoolOverrideApplied],
      ['No Fixed Candidate Cap', model.autonomy.noFixedCandidateCap],
      ['No Hard Learning Bans', model.autonomy.noHardLearningBans],
      ['Eligible', model.autonomy.eligible],
      ['Forwarded To Latch', model.autonomy.forwardedToLatch],
      ['Blocked', model.autonomy.blocked],
    ]) + `\n\n` +
    `## Learning Actions\n\n${actionRows.length ? markdownTable(['Action','Target','Reason'], actionRows) : 'No learning actions published.'}\n\n` +
    `## Pair Confidence\n\n${pairRows.length ? markdownTable(['Pair','Closed','Wins','Losses','Confidence','Status'], pairRows) : 'No pair confidence rows published.'}\n\n` +
    `## Timeframe Confidence\n\n${tfRows.length ? markdownTable(['Timeframe','Closed','Wins','Losses','Confidence','Status'], tfRows) : 'No timeframe confidence rows published.'}\n\n` +
    `## Runtime Supervisor\n\n` +
    markdownTable(['Metric','Value'], [
      ['Status', model.runtime.supervisor.status || 'NOT_AVAILABLE'],
      ['Last Decision', model.runtime.supervisor.lastDecision || '—'],
      ['Last Decision At', model.runtime.supervisor.lastDecisionAt || '—'],
      ['Consecutive Probe Failures', fmt(model.runtime.supervisor.consecutiveProbeFailures, 0)],
      ['Consecutive Fast Stalls', fmt(model.runtime.supervisor.consecutiveFastStalls, 0)],
      ['Controlled Restarts', fmt(model.runtime.supervisor.restartCount, 0)],
      ['Last Restart Reason', model.runtime.supervisor.lastRestartReason || '—'],
      ['Heavy Mode', model.runtime.heavy.mode || '—'],
      ['Heavy Circuit Reason', model.runtime.heavy.circuitReason || '—'],
    ]) + `\n\n` +
    `## Warnings\n\n${model.warnings.length ? model.warnings.map(row => `- ${row.type} ${row.key}: ${row.status} — ${row.message}`).join('\n') : '- None'}\n\n` +
    `---\nThis report is generated directly from the current v10.2.1 supervised operational authority. Cached or legacy snapshots cannot publish PASS.\n`;
}

function csvEscape(value) {
  const raw = String(value ?? '');
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function toCsv(model) {
  const rows = [['category','metric','value','status','generated_at']];
  const push = (category, metric, value, status = '') => rows.push([category, metric, value, status, model.generatedAt]);
  push('system','version',model.version,model.acceptance.status);
  push('system','labRunning',model.labRunning,model.status);
  push('system','researchReady',model.researchReady,model.status);
  push('safety','paperOnly',model.execution.paperOnly,'LOCKED');
  push('safety','liveCapitalExecution',model.execution.liveCapitalExecution,'LOCKED');
  push('safety','testnetExecution',model.execution.testnetExecution,'LOCKED');
  for (const [key, value] of Object.entries(model.metrics)) push('metrics', key, value, 'CURRENT');
  for (const [name, gate] of Object.entries(asObject(model.gates))) push('gate', name, gate && gate.pass, gate && gate.status);
  for (const [name, layer] of Object.entries(asObject(model.layers))) push('layer', name, layer && layer.ageSec, layer && layer.status);
  for (const [key, value] of Object.entries(model.performance.familyAdjusted)) push('familyAdjusted', key, value, model.gates.learning && model.gates.learning.status);
  for (const [key, value] of Object.entries(model.autonomy)) push('autonomy', key, value, model.autonomy.status);
  for (const [key, value] of Object.entries(model.candidateCohort)) push('candidateCohort', key, value, model.candidateCohort.status);
  for (const [key, value] of Object.entries(model.runtime.supervisor || {})) {
    if (!Array.isArray(value) && (value === null || typeof value !== 'object')) push('runtimeSupervisor', key, value, model.runtime.supervisor.status || '');
  }
  for (const row of asArray(model.learning.pairConfidence)) push('pairConfidence', row.key, row.confidenceScore, row.status);
  for (const row of asArray(model.learning.timeframeConfidence)) push('timeframeConfidence', row.key, row.confidenceScore, row.status);
  return rows.map(row => row.map(csvEscape).join(',')).join('\n') + '\n';
}

function toHtml(model) {
  const markdown = toMarkdown(model);
  const sections = markdown
    .split('\n')
    .map(line => {
      if (line.startsWith('# ')) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      if (line.startsWith('## ')) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      if (line.startsWith('- ')) return `<div class="bullet">${escapeHtml(line.slice(2))}</div>`;
      if (line.startsWith('|')) return `<pre>${escapeHtml(line)}</pre>`;
      if (line === '---') return '<hr>';
      return line ? `<p>${escapeHtml(line)}</p>` : '';
    }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ALPS Operational Truth Report</title><style>body{font-family:Arial,sans-serif;color:#111;max-width:1000px;margin:0 auto;padding:28px;line-height:1.45}h1{font-size:28px;margin:0 0 18px}h2{font-size:19px;margin-top:28px;border-bottom:2px solid #111;padding-bottom:6px}.bullet{margin:5px 0}pre{white-space:pre-wrap;font:12px ui-monospace,monospace;background:#f5f5f5;padding:8px;margin:2px 0}p{margin:5px 0}.status{padding:12px;border:2px solid #111;margin-bottom:18px;font-weight:700}@media print{body{padding:0}.no-print{display:none}}</style></head><body><button class="no-print" onclick="window.print()">Print / Save PDF</button><div class="status">${escapeHtml(model.acceptance.status)} · ${escapeHtml(model.generatedAt)}</div>${sections}</body></html>`;
}

function buildReportManifest(model) {
  return {
    schema: 'alps.v10201.reportManifest.v1',
    version: model.version,
    generatedAt: model.generatedAt,
    sourceOfTruth: model.sourceOfTruth,
    status: model.acceptance.status,
    formats: [
      { format: 'json', contentType: 'application/json', url: '/runner/report.json' },
      { format: 'markdown', contentType: 'text/markdown', url: '/runner/report.md' },
      { format: 'csv', contentType: 'text/csv', url: '/runner/report.csv' },
      { format: 'html', contentType: 'text/html', url: '/runner/report.html' },
    ],
    rule: 'Every report is generated on demand from current v10.2.1 supervised operational authority. No cached dashboard guesses are used.',
  };
}

module.exports = { buildDashboardModel, buildReportManifest, toMarkdown, toCsv, toHtml };
