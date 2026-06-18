FROM mcr.microsoft.com/playwright:v1.48.2-jammy

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app/server-runner

RUN curl -fsSL https://clever-duckanoo-f102c0.netlify.app/server-runner/package.json -o package.json \
 && curl -fsSL https://clever-duckanoo-f102c0.netlify.app/server-runner/runner.js -o runner.js \
 && node -e "let p=require('./package.json'); p.dependencies={playwright:'1.48.2'}; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2));"

RUN node <<'NODE'
const fs = require('fs');
let s = fs.readFileSync('runner.js','utf8');

s = s.replace(
  "'--autoplay-policy=no-user-gesture-required'",
  "'--autoplay-policy=no-user-gesture-required','--disable-gpu','--no-zygote','--memory-pressure-off'"
);

s = s.replace(
"async function ensureRuntimeStarted() {",
`async function applyBootstrapSettings() {
  if (!page || page.isClosed()) return;
  await page.evaluate(() => {
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) {
        el.value = String(val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };

    // BOOTSTRAP MODE: lighter startup for Render Free only.
    // This is NOT a trade cap. We will expand later.
    set('cfgSymbols', 'BTCUSDT,ETHUSDT,SOLUSDT');
    set('cfgMetals', '');
    set('cfgDays', '45');
    set('cfgFrames', '15m,30m,1h');
    set('cfgMaxCandles', '4000');
    set('cfgDelay', '120');

    set('cfgRounds', '3');
    set('cfgMuts', '80');
    set('cfgCycles', '25');

    if (typeof stopReq !== 'undefined') stopReq = false;
    if (typeof emergencyStopActive !== 'undefined') emergencyStopActive = false;
  });
}

async function ensureRuntimeStarted() {`
);

s = s.replace(
"  const h = await getPageHealth();\n  Object.assign(lastHealth, h, { status: 'LOADED', lastError: '' });",
"  await applyBootstrapSettings().catch(e => log('Bootstrap settings failed:', e.message));\n  const h = await getPageHealth();\n  Object.assign(lastHealth, h, { status: 'LOADED', lastError: '' });"
);

s = s.replace(
"if (url.pathname.startsWith('/runner/')) return send(res, 404, { error: 'Unknown runner endpoint' });",
`if (url.pathname === '/runner/start-lab') return send(res, 200, await runCommand('start-lab', {}));
      if (url.pathname === '/runner/start-watch') return send(res, 200, await runCommand('start-watch', {}));
      if (url.pathname === '/runner/tick') return send(res, 200, await runCommand('tick', {}));
      if (url.pathname === '/runner/reload') return send(res, 200, await runCommand('reload', {}));
      if (url.pathname.startsWith('/runner/')) return send(res, 404, { error: 'Unknown runner endpoint' });`
);

s = s.replace(
"if (command === 'start-lab') {\n    await pageEval(() => { if (typeof startLab === 'function') startLab(); return true; });",
"if (command === 'start-lab') {\n    await applyBootstrapSettings().catch(e => log('Bootstrap settings failed:', e.message));\n    await pageEval(() => { if (typeof startLab === 'function') startLab(); else document.getElementById('startLabBtn')?.click(); return true; });"
);

s = s.replace(
`async function main() {
  await ensureDirs();
  await createServer();
  await launchAppPage();
  await runnerTick('startup');
  setInterval(() => runnerTick('server-runner interval').catch(e => log(e.message)), TICK_MS);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log('ALPS Server Runner is active. Health:', \`http://127.0.0.1:\${PORT}/runner/health\`);
}`,
`async function main() {
  await ensureDirs();
  await createServer();

  try {
    await launchAppPage();
    await runnerTick('startup');
  } catch (e) {
    lastHealth.status = 'STARTUP_FAILED';
    lastHealth.lastError = e && (e.stack || e.message) || String(e);
    log('Startup failed but HTTP server remains alive:', lastHealth.lastError);
  }

  setInterval(() => runnerTick('server-runner interval').catch(e => log(e.stack || e.message)), TICK_MS);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log('ALPS Server Runner HTTP is active. Health:', \`http://127.0.0.1:\${PORT}/runner/health\`);
}`
);

s = s.replace(
"console.error(err);\n  process.exit(1);",
"console.error(err && (err.stack || err.message) || err);\n  process.exit(1);"
);

fs.writeFileSync('runner.js', s);
NODE

RUN npm install --omit=dev --no-audit --no-fund && npm run check

ENV HOST=0.0.0.0
ENV PORT=8787
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=256

ENV ALPS_APP_URL=https://clever-duckanoo-f102c0.netlify.app/
ENV ALPS_AUTO_START_WATCH=1
ENV ALPS_AUTO_START_LAB=1
ENV ALPS_HEADLESS=1
ENV ALPS_TICK_MS=60000

EXPOSE 8787

CMD ["npm", "start"]
