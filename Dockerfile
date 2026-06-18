FROM mcr.microsoft.com/playwright:v1.48.2-jammy

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app/server-runner

RUN curl -fsSL https://clever-duckanoo-f102c0.netlify.app/server-runner/package.json -o package.json \
 && curl -fsSL https://clever-duckanoo-f102c0.netlify.app/server-runner/runner.js -o runner.js \
 && node -e "let p=require('./package.json'); p.dependencies={playwright:'1.48.2'}; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2));" \
 && node <<'NODE'
const fs = require('fs');
let s = fs.readFileSync('runner.js','utf8');

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

  let browserOk = false;
  try {
    await launchAppPage();
    browserOk = true;
  } catch (e) {
    lastHealth.status = 'BROWSER_LAUNCH_FAILED';
    lastHealth.lastError = e && (e.stack || e.message || JSON.stringify(e)) || String(e);
    log('ALPS browser launch failed:');
    log(lastHealth.lastError);
  }

  if (browserOk) {
    try {
      await runnerTick('startup');
    } catch (e) {
      lastHealth.lastError = e && (e.stack || e.message) || String(e);
      log('Startup tick failed:', lastHealth.lastError);
    }
    setInterval(() => runnerTick('server-runner interval').catch(e => log(e.stack || e.message)), TICK_MS);
    lastHealth.status = 'RUNNING';
  } else {
    setInterval(() => log('ALPS runner server alive, browser launch failed:', lastHealth.lastError), 60000);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log('ALPS Server Runner HTTP is active. Health:', \`http://127.0.0.1:\${PORT}/runner/health\`);
}`);

s = s.replace(
`console.error(err);
  process.exit(1);`,
`console.error(err && (err.stack || err.message) || err);
  process.exit(1);`
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
ENV ALPS_AUTO_START_LAB=0
ENV ALPS_HEADLESS=1
ENV ALPS_TICK_MS=60000

EXPOSE 8787

CMD ["npm", "start"]
