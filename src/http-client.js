'use strict';

const { summarizeError } = require('./utils');

class InternalHttpClient {
  constructor({ baseUrl, token, timeoutMs = 20_000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token || '';
    this.timeoutMs = timeoutMs;
  }

  url(pathname) {
    const url = new URL(pathname, this.baseUrl);
    if (this.token) url.searchParams.set('token', this.token);
    return url;
  }

  async request(pathname, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    const headers = { accept: 'application/json', ...(options.headers || {}) };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    try {
      const response = await fetch(this.url(pathname), {
        method: options.method || 'GET',
        headers,
        body: options.body,
        signal: controller.signal,
      });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = raw; }
      return { ok: response.ok, status: response.status, data, raw, headers: response.headers };
    } catch (error) {
      return { ok: false, status: 0, data: null, raw: '', error: summarizeError(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  get(pathname, options) { return this.request(pathname, options); }
  postJson(pathname, body, options = {}) {
    return this.request(pathname, {
      ...options,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      body: JSON.stringify(body || {}),
    });
  }
}

module.exports = { InternalHttpClient };
