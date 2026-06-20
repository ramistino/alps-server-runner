'use strict';

const express = require('express');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT || 10000);
const RAW_APP_URL = process.env.APP_URL || process.env.ALPS_APP_URL || process.env.RUNNER_APP_URL || process.env.TARGET_URL || process.env.NETLIFY_URL || 'https://clever-duckanoo-f102c0.netlify.app/';
const APP_URL = String(RAW_APP_URL).trim().split('?')[0].split('#')[0].replace(/\/+$/, '') + '/' || 'https://clever-duckanoo-f102c0.netlify.app/';
const CYCLE_MS = Number(process.env.RUNNER_CYCLE_MS || 30000);
const START_LAB = String(process.env.START_LAB || 'true').toLowerCase() !== 'false';
const START_FORWARD = String(process.env.START_FORWARD || 'true').toLowerCase() !== 'false';

let browser = null;
let page = null;
let startedAt = Date.now();
let lastTickAt = 0;
let lastReportAt = 0;
let lastError = '';
let status = 'STARTING';
let cachedReport = '# ALPS Server Runner\n\nStarting...';
let cachedSnapshot = {};
let cycleTimer = null;
let booting = false;
let restarting = false;

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function log(...args){ console.log(new Date().toISOString(), ...args); }
function cleanUrl(u){
  const base = String(u).split('?')[0].split('#')[0].replace(/\/+$/, '');
  return `${base}/?renderRunner=1&v=917-ahi-core-render`;
}

async function evaluateSafe(fn, fallback, arg){
  try{
    if(!page || page.isClosed()) return fallback;
    return await page.evaluate(fn, arg);
  }catch(e){
    lastError = e && e.message ? e.message : String(e);
    return fallback;
  }
}

async function getSnapshot(){
  const snap = await evaluateSafe(async () => {
    const g = (name, fallback=null) => {
      try { return eval(`typeof ${name} !== 'undefined' ? ${name} : undefined`) ?? fallback; } catch(_) { return fallback; }
    };
    let reportObj = null;
    try{
      if(typeof buildRunReportObject === 'function') reportObj = await buildRunReportObject();
    }catch(e){ reportObj = { error: e.message }; }
    const runtime = reportObj && reportObj.runtime ? reportObj.runtime : {};
    const fw = reportObj && reportObj.forwardWatch ? reportObj.forwardWatch : {};
    const research = reportObj && reportObj.research ? reportObj.research : {};
    return {
      appVersion: g('APP_VERSION', reportObj?.meta?.version || ''),
      url: location.href,
      title: document.title,
      labRunning: g('labRunning', false),
      fwRunning: g('fwRunning', false),
      preflight: g('preflightStatus', runtime.preflight || ''),
      engineReady: g('engineReady', runtime.engineWorker === 'ON'),
      browserServerReady: true,
      candidates: Array.isArray(g('candidatesAll', [])) ? g('candidatesAll', []).length : (fw.candidatesMonitored || 0),
      officialCandidates: fw.candidatesMonitored || 0,
      results: Array.isArray(g('results', [])) ? g('results', []).length : (research.strategies || 0),
      paperSignals: Array.isArray(g('paperSignals', [])) ? g('paperSignals', []).length : (fw.paperSignals || 0),
      openPositions: Array.isArray(g('openPositions', [])) ? g('openPositions', []).length : (fw.openPositions || 0),
      closedTrades: Array.isArray(g('closedTrades', [])) ? g('closedTrades', []).length : (fw.closedTrades || 0),
      rejectedSignals: Array.isArray(g('rejectedSignals', [])) ? g('rejectedSignals', []).length : (fw.rejectedSignals || 0),
      wins: fw.wins || 0,
      losses: fw.losses || 0,
      winRate: fw.winRate ?? null,
      lastForwardRefresh: g('lastForwardRefreshTs', null),
      fwRefreshRunning: g('fwRefreshRunning', false),
      missedForwardCycles: g('fwMissedCycles', 0),
      rtPrepared: g('rtPrepared', runtime.runtime === 'READY'),
      reportObj
    };
  }, {});
  cachedSnapshot = snap || {};
  return cachedSnapshot;
}

async function buildReport(){
  const md = await evaluateSafe(async () => {
    if(typeof buildRunReportObject === 'function' && typeof runReportToMarkdown === 'function'){
      const r = await buildRunReportObject();
      return runReportToMarkdown(r);
    }
    return '# ALPS Run Report\n\nReport functions are not ready yet.';
  }, null);
  if(md){
    cachedReport = md;
    lastReportAt = Date.now();
  }
  return cachedReport;
}

async function ensureStarted(){
  await evaluateSafe(async (opts = {}) => {
    const START_LAB = opts.START_LAB !== false;
    const START_FORWARD = opts.START_FORWARD !== false;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    try{
      if(START_LAB && typeof startLab === 'function'){
        const resultsReady = (typeof results !== 'undefined' && Array.isArray(results) && results.length > 0);
        if(!resultsReady && !(typeof labRunning !== 'undefined' && labRunning)){
          startLab();
        }
      }
      await wait(2500);
      if(START_FORWARD && typeof startWatch === 'function'){
        const canStart = !(typeof fwRunning !== 'undefined' && fwRunning);
        const hasResults = (typeof results !== 'undefined' && Array.isArray(results) && results.length > 0);
        if(canStart && hasResults){
          startWatch();
        }
      }
      return true;
    }catch(e){
      console.error('Render runner auto-start error', e);
      return false;
    }
  }, false, { START_LAB, START_FORWARD });
}

async function boot(){
  if(booting) return;
  booting = true;
  status = 'BOOTING';
  try{
    log('Launching Chromium for ALPS:', APP_URL);
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-dev-shm-usage','--disable-setuid-sandbox','--disable-gpu']
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    page.on('console', msg => {
      const text = msg.text();
      if(/error|warning|runner|paper signal|AHI|CORE|fresh/i.test(text)) log('[page]', text.slice(0, 500));
    });
    page.on('pageerror', err => { lastError = err.message; log('[pageerror]', err.message); });
    await page.goto(cleanUrl(APP_URL), { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(()=>{});
    await sleep(3000);
    await ensureStarted();
    status = 'RUNNING';
    lastError = '';
    await tick();
    if(cycleTimer) clearInterval(cycleTimer);
    cycleTimer = setInterval(() => tick().catch(e => { lastError = e.message; log('tick error', e.message); }), CYCLE_MS);
  }catch(e){
    status = 'ERROR';
    lastError = e && e.message ? e.message : String(e);
    log('BOOT ERROR', lastError);
    setTimeout(() => restart().catch(()=>{}), 15000);
  }finally{
    booting = false;
  }
}

async function restart(){
  if(restarting) return;
  restarting = true;
  try{
    status = 'RESTARTING';
    if(cycleTimer) clearInterval(cycleTimer);
    cycleTimer = null;
    if(page && !page.isClosed()) await page.close().catch(()=>{});
    if(browser) await browser.close().catch(()=>{});
    browser = null; page = null;
    await sleep(1000);
    await boot();
  }finally{
    restarting = false;
  }
}

async function tick(){
  lastTickAt = Date.now();
  if(!page || page.isClosed()) throw new Error('page closed');
  await ensureStarted();
  await getSnapshot();
  await buildReport();
  status = 'RUNNING';
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.get('/', (req,res) => res.redirect('/runner/health'));
app.get('/runner/health', async (req,res) => {
  const snap = await getSnapshot().catch(()=>cachedSnapshot || {});
  res.json({
    status,
    startedAt,
    lastTickAt,
    lastReportAt,
    lastError,
    appUrl: APP_URL,
    appVersion: snap.appVersion || '',
    candidates: snap.candidates || 0,
    fwRunning: !!snap.fwRunning,
    labRunning: !!snap.labRunning,
    openPositions: snap.openPositions || 0,
    closedTrades: snap.closedTrades || 0,
    paperSignals: snap.paperSignals || 0,
    rejectedSignals: snap.rejectedSignals || 0,
    winRate: snap.winRate ?? null,
    missedForwardCycles: snap.missedForwardCycles || 0,
    serverRunner: 'ON',
    rtPrepared: !!snap.rtPrepared,
    officialCandidates: snap.officialCandidates || 0,
    results: snap.results || 0,
    wins: snap.wins || 0,
    losses: snap.losses || 0,
    lastForwardRefresh: snap.lastForwardRefresh || 0,
    fwRefreshRunning: !!snap.fwRefreshRunning,
    emergencyStopActive: false,
    preflight: snap.preflight || '',
    engineReady: !!snap.engineReady,
    browserServerReady: true
  });
});
app.get('/runner/report.md', async (req,res) => {
  await buildReport().catch(()=>{});
  res.type('text/markdown').send(cachedReport);
});
app.post('/runner/restart', async (req,res) => {
  restart().catch(e => { lastError = e.message; });
  res.json({ ok: true, status: 'RESTARTING' });
});
app.get('/runner/screenshot.png', async (req,res) => {
  try{
    if(!page || page.isClosed()) throw new Error('page closed');
    const buf = await page.screenshot({ fullPage: false });
    res.type('png').send(buf);
  }catch(e){ res.status(500).send(e.message); }
});

app.listen(PORT, () => {
  log(`ALPS Render runner listening on ${PORT}`);
  boot().catch(e => { lastError = e.message; log('boot failed', e.message); });
});

process.on('SIGTERM', async () => {
  log('SIGTERM received');
  if(browser) await browser.close().catch(()=>{});
  process.exit(0);
});

process.on('unhandledRejection', err => {
  lastError = err && err.message ? err.message : String(err);
  console.error('Unhandled rejection:', lastError);
});
process.on('uncaughtException', err => {
  lastError = err && err.message ? err.message : String(err);
  console.error('Uncaught exception:', lastError);
});
