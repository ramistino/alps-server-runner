#!/usr/bin/env node
'use strict';
const { main } = require('./v1207-main');
main().catch(error => {
  console.error(new Date().toISOString(), '[v12.0.7.3] fatal startup error', error && error.stack || error);
  process.exitCode = 1;
});
