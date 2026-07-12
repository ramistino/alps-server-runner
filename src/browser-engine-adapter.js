'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { InternalHttpClient } = require('./http-client');
const { iso, summarizeError, text } = require('./utils');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

class BrowserEngineAdapter {
  constructor(config, log = console.log) {
    this.config = config;
    this.log = log;
    this.child = null;
    this.startedAt = null;
    this.restartCount = 0;
    this.lastExit = null;
    this.lastReadyAt = null;
    this.lastProbeAt = null;
    this.lastProbeStatus = null;
    this.consecutiveProbeFailures = 0;
    this.lastRestartAt = null;
    this.lastRestartReason = null;
    this.restartHistory = [];
    this.restartPromise = null;
    this.stopping = false;
    this.client = new InternalHttpClient({
      baseUrl:config.internalBaseUrl,
      token:config.token,
      timeoutMs:30_000,
    });
  }

  status() {
    return {
      schema:'alps.v10201.browserEngineAdapter.v1',
      mode:'ISOLATED_LEGACY_BROWSER_ENGINE_ADAPTER',
      running:Boolean(this.child && this.child.exitCode === null && !this.child.killed),
      pid:this.child && this.child.pid || null,
      startedAt:this.startedAt,
      restartCount:this.restartCount,
      lastRestartAt:this.lastRestartAt,
      lastRestartReason:this.lastRestartReason,
      restartInFlight:Boolean(this.restartPromise),
      restartHistory:this.restartHistory.slice(-10),
      lastExit:this.lastExit,
      lastReadyAt:this.lastReadyAt,
      lastProbeAt:this.lastProbeAt,
      lastProbeStatus:this.lastProbeStatus,
      consecutiveProbeFailures:this.consecutiveProbeFailures,
      activeInternalRequests:this.client.activeView(),
      internalBaseUrl:this.config.internalBaseUrl,
      publicExposure:false,
      strategyEngineRewritten:false,
      controlPlaneRebuilt:true,
      supervisedContinuousRuntime:true,
      autoStartWatch:true,
      autoStartLab:true,
      rule:'The private browser engine is supervised independently. Repeated direct probe failures or a stale fast-control heartbeat trigger a controlled child restart without touching persistent evidence.',
    };
  }

  async start() {
    if (this.child && this.child.exitCode === null) return this.status();
    if (!fs.existsSync(this.config.legacyRunnerPath)) {
      throw new Error(`Legacy browser engine adapter missing: ${this.config.legacyRunnerPath}`);
    }

    this.stopping = false;
    this.startedAt = iso();
    const parentAppDir = path.resolve(this.config.rootDir, '..');
    const localAppDir = path.resolve(this.config.rootDir);
    const detectedAppDir = process.env.ALPS_APP_DIR || (
      fs.existsSync(path.join(parentAppDir, 'index.html')) ? parentAppDir :
      fs.existsSync(path.join(localAppDir, 'index.html')) ? localAppDir :
      parentAppDir
    );

    const env = {
      ...process.env,
      PORT:String(this.config.internalPort),
      ALPS_RUNNER_PORT:String(this.config.internalPort),
      HOST:this.config.internalHost,
      ALPS_APP_DIR:detectedAppDir,
      ALPS_DATA_DIR:process.env.ALPS_DATA_DIR || path.join(this.config.rootDir, 'data'),
      ALPS_REPORT_DIR:process.env.ALPS_REPORT_DIR || path.join(this.config.rootDir, 'data', 'reports'),
      ALPS_PROFILE_DIR:process.env.ALPS_PROFILE_DIR || path.join(this.config.rootDir, 'data', 'chromium-profile'),
      ALPS_V102_ADAPTER_MODE:'1',
      ALPS_V102_PUBLIC_PORT:String(this.config.publicPort),
      ALPS_AUTO_START_WATCH:'1',
      ALPS_AUTO_START_LAB:'1',

      BINANCE_TESTNET_API_KEY:'',
      BINANCE_TESTNET_API_SECRET:'',
      ALPS_TESTNET_API_KEY:'',
      ALPS_TESTNET_API_SECRET:'',
      ALPS_TESTNET_ORDER_NOTIONAL_USDT:'0',
      ALPS_TESTNET_ORDER_QTY:'',
      ALPS_LIVE_CAPITAL_EXECUTION:'0',
      ALPS_ENABLE_LIVE_EXECUTION:'0',
    };

    const child = spawn(process.execPath, [this.config.legacyRunnerPath], {
      cwd:this.config.rootDir,
      env,
      stdio:['ignore','pipe','pipe'],
    });
    this.child = child;
    child.stdout.on('data', chunk => this.log(`[browser-engine] ${text(chunk).trimEnd()}`));
    child.stderr.on('data', chunk => this.log(`[browser-engine:err] ${text(chunk).trimEnd()}`));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.lastExit = { code, signal, at:iso(), expected:this.stopping };
      this.log(`[browser-engine] exited code=${code} signal=${signal || ''} expected=${this.stopping}`);
      if (!this.stopping && !this.restartPromise) {
        this.restartCount += 1;
        const delay = Math.min(60_000, 2_000 * Math.max(1, this.restartCount));
        setTimeout(
          () => this.start().catch(error => this.log('[browser-engine] automatic restart failed', summarizeError(error))),
          delay
        ).unref();
      }
    });
    return this.status();
  }

  async probe(timeoutMs = this.config.supervisorProbeTimeoutMs || 5_000) {
    this.lastProbeAt = iso();
    const result = await this.client.get('/runner/version', { timeoutMs, group:'supervisor-probe' });
    this.lastProbeStatus = result.ok ? 'READY' : `FAILED_${result.status || 0}`;
    if (result.ok) {
      this.lastReadyAt = iso();
      this.consecutiveProbeFailures = 0;
    } else {
      this.consecutiveProbeFailures += 1;
    }
    return result;
  }

  async waitUntilReady(timeoutMs = this.config.childStartTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.probe(Math.min(5_000, this.config.supervisorProbeTimeoutMs || 5_000));
      if (last.ok && last.data && last.data.runtimeBootReady) {
        this.lastReadyAt = iso();
        return last.data;
      }
      await sleep(1_500);
    }
    throw new Error(
      `Browser engine adapter did not become ready within ${timeoutMs}ms; ` +
      `last=${JSON.stringify(last && (last.error || last.data || last.status))}`
    );
  }

  async restart(reason = 'SUPERVISOR_REQUEST') {
    if (this.restartPromise) return this.restartPromise;
    this.restartPromise = (async () => {
      const startedAt = iso();
      this.lastRestartAt = startedAt;
      this.lastRestartReason = reason;
      this.restartCount += 1;
      this.client.cancelAll(`ADAPTER_RESTART:${reason}`);
      this.log(`[browser-engine] controlled restart reason=${reason}`);
      await this.stop({ suppressAutoRestart:true });
      await sleep(750);
      await this.start();
      const ready = await this.waitUntilReady(this.config.adapterRestartReadyTimeoutMs);
      const row = { at:iso(), reason, ok:true, pid:this.child && this.child.pid || null };
      this.restartHistory.push(row);
      if (this.restartHistory.length > 20) this.restartHistory.splice(0, this.restartHistory.length - 20);
      this.consecutiveProbeFailures = 0;
      return { ok:true, ready, status:this.status() };
    })().catch(error => {
      const row = { at:iso(), reason, ok:false, error:summarizeError(error) };
      this.restartHistory.push(row);
      if (this.restartHistory.length > 20) this.restartHistory.splice(0, this.restartHistory.length - 20);
      throw error;
    }).finally(() => {
      this.restartPromise = null;
    });
    return this.restartPromise;
  }

  async stop({ suppressAutoRestart = true } = {}) {
    this.stopping = suppressAutoRestart;
    this.client.cancelAll('ADAPTER_STOP');
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      return;
    }
    child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 8_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (this.child === child) this.child = null;
  }
}

module.exports = { BrowserEngineAdapter };
