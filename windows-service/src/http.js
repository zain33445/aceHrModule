'use strict';

class HttpError extends Error {
  constructor(status, message, payload) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.payload = payload;
  }
}

function isAuthError(error) {
  return error instanceof HttpError && (error.status === 401 || error.status === 403);
}

function serverMessage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload.error?.message || payload.error || payload.message;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

async function requestJson(url, options = {}) {
  const {
    method = 'GET',
    token,
    body,
    timeoutMs = 15_000,
    headers = {}
  } = options;

  const requestHeaders = { Accept: 'application/json', ...headers };
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  if (token) requestHeaders.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response;
    let text;
    try {
      response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      text = await response.text();
    } catch (err) {
      const reason = err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message;
      throw new Error(`Request failed: ${reason}`);
    }

    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch {}
    }

    if (!response.ok) {
      const detail = serverMessage(payload);
      throw new HttpError(
        response.status,
        detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`,
        payload
      );
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { HttpError, isAuthError, requestJson };
