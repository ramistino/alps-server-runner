'use strict';

const { summarizeError } = require('./utils');

class InternalHttpClient {
  constructor({ baseUrl, token, timeoutMs = 20_000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token || '';
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.active = new Map();
  }

  url(pathname) {
    const url = new URL(pathname, this.baseUrl);
    if (this.token) url.searchParams.set('token', this.token);
    return url;
  }

  activeView() {
    return [...this.active.values()].map(row => ({
      id:row.id,
      pathname:row.pathname,
      group:row.group,
      startedAt:row.startedAt,
      timeoutMs:row.timeoutMs,
    }));
  }

  cancelGroup(group, reason = 'GROUP_CANCELLED') {
    let count = 0;
    for (const row of this.active.values()) {
      if (row.group !== group) continue;
      row.abortReason = reason;
      row.controller.abort(new Error(reason));
      count += 1;
    }
    return count;
  }

  cancelAll(reason = 'ALL_REQUESTS_CANCELLED') {
    let count = 0;
    for (const row of this.active.values()) {
      row.abortReason = reason;
      row.controller.abort(new Error(reason));
      count += 1;
    }
    return count;
  }

  async request(pathname, options = {}) {
    const id = ++this.sequence;
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const group = options.group || 'default';
    const startedAt = new Date().toISOString();
    const row = { id, pathname, group, controller, startedAt, timeoutMs, abortReason:null };
    this.active.set(id, row);
    const timer = setTimeout(() => {
      row.abortReason = 'REQUEST_TIMEOUT';
      controller.abort(new Error(`REQUEST_TIMEOUT_${timeoutMs}MS`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const headers = { accept:'application/json', ...(options.headers || {}) };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    try {
      const response = await fetch(this.url(pathname), {
        method:options.method || 'GET',
        headers,
        body:options.body,
        signal:controller.signal,
      });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = raw; }
      return { ok:response.ok, status:response.status, data, raw, headers:response.headers, requestId:id };
    } catch (error) {
      const summary = summarizeError(error);
      if (row.abortReason) summary.code = row.abortReason;
      return { ok:false, status:0, data:null, raw:'', error:summary, requestId:id };
    } finally {
      clearTimeout(timer);
      this.active.delete(id);
    }
  }

  get(pathname, options) { return this.request(pathname, options); }
  postJson(pathname, body, options = {}) {
    return this.request(pathname, {
      ...options,
      method:'POST',
      headers:{ 'content-type':'application/json', ...(options.headers || {}) },
      body:JSON.stringify(body || {}),
    });
  }
}

module.exports = { InternalHttpClient };
