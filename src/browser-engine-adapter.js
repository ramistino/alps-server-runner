'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { InternalHttpClient } = require('./http-client');
const { iso, summarizeError, text } = require('./utils');

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
    this.stopping = false;
    this.client = new InternalHttpClient({
      baseUrl:config.internalBaseUrl,
      token:config.token,
      timeoutMs:30_000,
    });
  }

  status() {
    return {
      schema:'alps.v10200.browserEngineAdapter.v2',
      mode:'ISOLATED_LEGACY_BROWSER_ENGINE_ADAPTER',
      running:Boolean(this.child && this.child.exitCode === null && !this.child.killed),
      pid:this.child && this.child.pid || null,
      startedAt:this.startedAt,
      restartCount:this.restartCount,
      lastExit:this.lastExit,
      lastReadyAt:this.lastReadyAt,
      lastProbeAt:this.lastProbeAt,
      lastProbeStatus:this.lastProbeStatus,
      internalBaseUrl:this.config.internalBaseUrl,
      publicExposure:false,
      strategyEngineRewritten:false,
      controlPlaneRebuilt:true,
      autoStartWatch:true,
      autoStartLab:true,
      rule:'The accumulated browser runner is isolated as a private strategy-engine adapter. It cannot publish public health or override v10.2.0 layer gates.',
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

      // Hard safety boundary: the private adapter never receives execution credentials.
      BINANCE_TESTNET_API_KEY:'',
      BINANCE_TESTNET_API_SECRET:'',
      ALPS_TESTNET_API_KEY:'',
      ALPS_TESTNET_API_SECRET:'',
      ALPS_TESTNET_ORDER_NOTIONAL_USDT:'0',
      ALPS_TESTNET_ORDER_QTY:'',
      ALPS_LIVE_CAPITAL_EXECUTION:'0',
      ALPS_ENABLE_LIVE_EXECUTION:'0',
    };

    this.child = spawn(process.execPath, [this.config.legacyRunnerPath], {
      cwd:this.config.rootDir,
      env,
      stdio:['ignore','pipe','pipe'],
    });
    this.child.stdout.on('data', chunk => this.log(`[browser-engine] ${text(chunk).trimEnd()}`));
    this.child.stderr.on('data', chunk => this.log(`[browser-engine:err] ${text(chunk).trimEnd()}`));
    this.child.on('exit', (code, signal) => {
      this.lastExit = { code, signal, at:iso(), expected:this.stopping };
      this.log(`[browser-engine] exited code=${code} signal=${signal || ''} expected=${this.stopping}`);
      if (!this.stopping) {
        this.restartCount += 1;
        const delay = Math.min(60_000, 2_000 * Math.max(1, this.restartCount));
        setTimeout(
          () => this.start().catch(error => this.log('[browser-engine] restart failed', summarizeError(error))),
          delay
        ).unref();
      }
    });
    return this.status();
  }

  async probe(timeoutMs = 5_000) {
    this.lastProbeAt = iso();
    const result = await this.client.get('/runner/version', { timeoutMs });
    this.lastProbeStatus = result.ok ? 'READY' : `FAILED_${result.status || 0}`;
    if (result.ok) this.lastReadyAt = iso();
    return result;
  }

  async waitUntilReady() {
    const deadline = Date.now() + this.config.childStartTimeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.probe(5_000);
      if (last.ok && last.data && last.data.runtimeBootReady) {
        this.lastReadyAt = iso();
        return last.data;
      }
      await new Promise(resolve => setTimeout(resolve, 1_500));
    }
    throw new Error(
      `Browser engine adapter did not become ready within ${this.config.childStartTimeoutMs}ms; ` +
      `last=${JSON.stringify(last && (last.error || last.data || last.status))}`
    );
  }

  async stop() {
    this.stopping = true;
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.child && this.child.exitCode === null) this.child.kill('SIGKILL');
        resolve();
      }, 10_000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

module.exports = { BrowserEngineAdapter };
