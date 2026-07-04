FROM mcr.microsoft.com/playwright:v1.61.1-jammy
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev
COPY runner.js /app/runner.js
COPY alpsTradeExport.js /app/alpsTradeExport.js
COPY recovery /app/recovery
ENV HOST=0.0.0.0
ENV PORT=8787
ENV ALPS_AUTO_START_WATCH=1
ENV ALPS_AUTO_START_LAB=0
ENV ALPS_HEADLESS=1
ENV ALPS_TICK_MS=60000
ENV ALPS_REPORT_EVERY_MS=60000
ENV ALPS_FORWARD_STALE_MS=5400000
ENV ALPS_AUTO_RELOAD_STALE_FORWARD=1
ENV ALPS_DATA_DIR=/data/alps
ENV ALPS_REPORT_DIR=/data/alps/reports
ENV ALPS_PROFILE_DIR=/data/alps/chromium-profile
EXPOSE 8787
CMD ["npm", "start"]
