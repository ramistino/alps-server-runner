FROM mcr.microsoft.com/playwright:v1.48.2-jammy

WORKDIR /app/server-runner

RUN curl -fsSL https://clever-duckanoo-f102c0.netlify.app/server-runner/package.json -o package.json \
 && curl -fsSL https://clever-duckanoo-f102c0.netlify.app/server-runner/runner.js -o runner.js \
 && npm install --omit=dev

ENV HOST=0.0.0.0
ENV PORT=8787
ENV ALPS_APP_URL=https://clever-duckanoo-f102c0.netlify.app/
ENV ALPS_AUTO_START_WATCH=1
ENV ALPS_AUTO_START_LAB=0
ENV ALPS_HEADLESS=1
ENV ALPS_TICK_MS=60000

CMD ["npm", "start"]
