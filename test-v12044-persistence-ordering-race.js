'use strict';

const assert = require('assert');
const { BudgetGuard, loadConfig } = require('./v1202-bundle');

(async () => {
  const config = loadConfig();
  config.forex.persistTimeoutMs = 10;
  config.forex.hardDailyCredits = 600;
  config.forex.scheduledCreditCeiling = 540;

  let call = 0;
  let persisted = null;

  const storage = {
    readJson: async () => null,
    writeJsonAtomic: async (_file, payload) => {
      const id = ++call;
      const snapshot = JSON.parse(JSON.stringify(payload));
      await new Promise(resolve => setTimeout(resolve, id === 1 ? 100 : 5));
      persisted = snapshot;
    },
  };

  const now = () => Date.parse('2026-07-23T12:00:00.000Z');
  const budget = new BudgetGuard({ config, storage, now });
  budget.state = budget.empty();

  await budget.reserve({ key: 'time_series:EURUSD:live', purpose: 'scheduled', cost: 1 });
  await budget.complete({ key: 'time_series:EURUSD:live', status: 429, error: 'rate limited' });
  await new Promise(resolve => setTimeout(resolve, 150));

  assert.strictEqual(budget.state.status, 'HTTP_429_STOPPED_UNTIL_NEXT_UTC_DAY');
  assert.strictEqual(persisted.status, 'HTTP_429_STOPPED_UNTIL_NEXT_UTC_DAY',
    `stale write won: persisted.status=${persisted.status}`);
  assert.ok(persisted.blockedUntil, 'blockedUntil must remain persisted');

  console.log(JSON.stringify({ status: 'PASS', calls: call, persistedStatus: persisted.status }, null, 2));
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
