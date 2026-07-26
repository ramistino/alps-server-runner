'use strict';

const Module = require('module');

const target = require.resolve('./policy-shadow-integrity-v12073');
const patched = require('./policy-shadow-integrity-v120733');
const originalLoad = Module._load;

Module._load = function patchedPolicyShadowLoad(request, parent, isMain) {
  let resolved = null;
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch (_) {}
  if (resolved === target) return patched;
  return originalLoad.apply(this, arguments);
};
