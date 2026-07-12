'use strict';

function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function integer(value, fallback = 0) { return Math.trunc(finite(value, fallback)); }
function bool(value) { return value === true; }
function text(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}
function iso(value = Date.now()) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
function timestamp(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const n = Number(value);
  if (Number.isFinite(n) && String(value).trim() !== '') return n > 1e12 ? n : n * 1000;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : 0;
}
function ageSec(value, now = Date.now()) {
  const t = timestamp(value);
  return t > 0 ? Math.max(0, (now - t) / 1000) : Number.POSITIVE_INFINITY;
}
function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function safeJsonParse(raw, fallback = null) {
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}
function deepGet(obj, path, fallback = undefined) {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || !(key in cur)) return fallback;
    cur = cur[key];
  }
  return cur;
}
function firstDefined(...values) {
  for (const v of values) if (v !== undefined && v !== null) return v;
  return undefined;
}
function canonicalPair(value) {
  const s = text(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (['PAXGUSDT', 'XAUUSDT', 'GOLDUSDT'].includes(s)) return 'XAUTUSDT';
  return s;
}
function canonicalTimeframe(value) {
  const s = text(value).trim().toLowerCase();
  const map = { '5min':'5m', '15min':'15m', '30min':'30m', '60m':'1h', '1hr':'1h', '240m':'4h', '4hr':'4h' };
  return map[s] || s;
}
function noCacheHeaders(extra = {}) {
  return {
    'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    pragma: 'no-cache',
    expires: '0',
    ...extra,
  };
}
function summarizeError(error) {
  return {
    name: text(error && error.name, 'Error'),
    message: text(error && error.message || error, 'Unknown error').slice(0, 500),
    code: error && error.code ? text(error.code) : undefined,
  };
}
function stableSort(rows, compare) {
  return rows.map((value, index) => ({ value, index }))
    .sort((a, b) => compare(a.value, b.value) || a.index - b.index)
    .map(x => x.value);
}

module.exports = {
  asArray, asObject, finite, integer, bool, text, iso, timestamp, ageSec, round, clamp,
  safeJsonParse, deepGet, firstDefined, canonicalPair, canonicalTimeframe, noCacheHeaders,
  summarizeError, stableSort,
};
