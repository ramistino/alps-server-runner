FROM mcr.microsoft.com/playwright:v1.48.2-jammy

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=1536

WORKDIR /app/server-runner

RUN curl -fsSL https://clever-duckanoo-f102c0.netlify.app/server-runner/package.json -o package.json \
 && curl -fsSL https://clever-duckanoo-f102c0.netlify.app/server-runner/runner.js -o runner.js \
 && node - <<'NODE'
const fs = require('fs');
const p = require('./package.json');
p.dependencies = p.dependencies || {};
p.dependencies.playwright = '1.48.2';
p.scripts = p.scripts || {};
p.scripts.start = 'node runner.js';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));
NODE

RUN npm install --omit=dev

RUN node <<'NODE'
const fs = require('fs');
let s = fs.readFileSync('runner.js', 'utf8');

function patchOnce(marker, replacement, label) {
  if (!s.includes(marker)) {
    console.log('Patch skipped, marker not found:', label);
    return;
  }
  s = s.replace(marker, replacement);
  console.log('Patch applied:', label);
}

s = s.replace(
  "'--autoplay-policy=no-user-gesture-required'\n    ]",
  "'--autoplay-policy=no-user-gesture-required',\n      '--disable-gpu',\n      '--no-zygote',\n      '--disable-extensions',\n      '--memory-pressure-off',\n      '--js-flags=--max-old-space-size=1536'\n    ]"
);

const loadMarker = "  log(`ALPS app loaded: ${appUrl}`);";
const fullConfigPatch = [
  "  const fullConfig = {",
  "    symbols: process.env.ALPS_FULL_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT',",
  "    metals: process.env.ALPS_FULL_METALS || 'XAUTUSDT',",
  "    days: process.env.ALPS_FULL_DAYS || '180',",
  "    frames: process.env.ALPS_FULL_FRAMES || '5m,15m,30m,1h,4h',",
  "    maxCandles: process.env.ALPS_FULL_MAX_CANDLES || '12000',",
  "    delay: process.env.ALPS_FULL_DELAY_MS || '80',",
  "    rounds: process.env.ALPS_FULL_ROUNDS || '6',",
  "    mutations: process.env.ALPS_FULL_MUTATIONS || '200',",
  "    cycles: process.env.ALPS_FULL_CYCLES || '99',",
  "    fwMax: process.env.ALPS_FULL_FORWARD_CANDIDATES || '360',",
  "    fwLookback: process.env.ALPS_FULL_FW_LOOKBACK || '400',",
  "    fwMinScore: process.env.ALPS_FULL_MIN_SIGNAL_SCORE || '35'",
  "  };",
  "  await page.evaluate(cfg => {",
  "    const set = (id, value) => {",
  "      const el = document.getElementById(id);",
  "      if (!el) return false;",
  "      el.value = String(value);",
  "      el.dispatchEvent(new Event('input', { bubbles: true }));",
  "      el.dispatchEvent(new Event('change', { bubbles: true }));",
  "      return true;",
  "    };",
  "    set('cfgSymbols', cfg.symbols);",
  "    set('cfgMetals', cfg.metals);",
  "    set('cfgDays', cfg.days);",
  "    set('cfgFrames', cfg.frames);",
  "    set('cfgMaxCandles', cfg.maxCandles);",
  "    set('cfgDelay', cfg.delay);",
  "    set('cfgRounds', cfg.rounds);",
  "    set('cfgMuts', cfg.mutations);",
  "    set('cfgCycles', cfg.cycles);",
  "    set('cfgFwMax', cfg.fwMax);",
  "    set('cfgFwLookback', cfg.fwLookback);",
  "    set('cfgFwMinScore', cfg.fwMinScore);",
  "    window.ALPS_SERVER_FULL_RESEARCH_MODE = true;",
  "    try { localStorage.setItem('ALPS_SERVER_FULL_RESEARCH_CONFIG', JSON.stringify(cfg)); } catch (_) {}",
  "    if (typeof renderAll === 'function') renderAll();",
  "    return true;",
  "  }, fullConfig).catch(e => log('Full research config apply failed:', e.message));",
  "  log('ALPS Full Research Lab Mode config applied:', JSON.stringify(fullConfig));",
  "  log(`ALPS app loaded: ${appUrl}`);"
].join('\n');

patchOnce(loadMarker, fullConfigPatch, 'full research config before lab start');

const mainMarker = [
  "async function main() {",
  "  await ensureDirs();",
  "  await createServer();",
  "  await launchAppPage();",
  "  await runnerTick('startup');",
  "  setInterval(() => runnerTick('server-runner interval').catch(e => log(e.message)), TICK_MS);"
].join('\n');

const mainPatch = [
  "async function main() {",
  "  await ensureDirs();",
  "  await createServer();",
  "  try {",
  "    await launchAppPage();",
  "    await runnerTick('startup');",
  "  } catch (e) {",
  "    lastHealth.status = 'ERROR';",
  "    lastHealth.lastError = e.message;",
  "    log('Recoverable startup error. Health endpoint stays alive; interval will retry:', e.stack || e.message);",
  "  }",
  "  setInterval(() => runnerTick('server-runner interval').catch(e => log(e.message)), TICK_MS);"
].join('\n');

patchOnce(mainMarker, mainPatch, 'health server survives startup errors');

fs.writeFileSync('runner.js', s);
NODE

ENV HOST=0.0.0.0
ENV PORT=8787
ENV ALPS_APP_URL=https://clever-duckanoo-f102c0.netlify.app/
ENV ALPS_AUTO_START_WATCH=1
ENV ALPS_AUTO_START_LAB=1
ENV ALPS_HEADLESS=1
ENV ALPS_TICK_MS=60000
ENV ALPS_REPORT_EVERY_MS=60000

# ALPS v9.1.7 Full Research Lab Mode — paper-forward only.
ENV ALPS_FULL_RESEARCH_MODE=1
ENV ALPS_BOOTSTRAP_MODE=0
ENV ALPS_FULL_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT
ENV ALPS_FULL_METALS=XAUTUSDT
ENV ALPS_FULL_DAYS=180
ENV ALPS_FULL_FRAMES=5m,15m,30m,1h,4h
ENV ALPS_FULL_MAX_CANDLES=12000
ENV ALPS_FULL_DELAY_MS=80
ENV ALPS_FULL_ROUNDS=6
ENV ALPS_FULL_MUTATIONS=200
ENV ALPS_FULL_CYCLES=99
ENV ALPS_FULL_FORWARD_CANDIDATES=360
ENV ALPS_FULL_FW_LOOKBACK=400
ENV ALPS_FULL_MIN_SIGNAL_SCORE=35

EXPOSE 8787
CMD ["npm", "start"]
