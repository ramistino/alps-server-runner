#!/usr/bin/env node
'use strict';
const { main } = require('./v1202-bundle');
main().catch(error => {
  console.error(new Date().toISOString(), '[v12.0.6] fatal startup error', error && error.stack || error);
  process.exitCode = 1;
});
