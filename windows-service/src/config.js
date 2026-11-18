'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SERVICE_NAME = 'aceHRMDeviceService';
const SERVICE_DISPLAY_NAME = 'aceHRM Device Service';
const DEFAULT_PIPE_NAME = 'acehrm-device-service';
const DEFAULT_API_BASE = 'https://api.theaceservices.site/api';
const AGENT_VERSION = require('../package.json').version;

function programDataRoot() {
  return process.env.ProgramData || process.env.PROGRAMDATA || 'C:\\ProgramData';
}

const dataDir = process.env.ACEHRM_DEVICE_DATA_DIR
  ? path.resolve(process.env.ACEHRM_DEVICE_DATA_DIR)
  : path.join(programDataRoot(), 'aceHRM');

const paths = {
  dataDir,
  configFile: path.join(dataDir, 'device-service.json'),
  stateDir: path.join(dataDir, 'state'),
  identityFile: path.join(dataDir, 'state', 'identity.json'),
  credentialsFile: path.join(dataDir, 'state', 'credentials.json'),
  logsDir: path.join(dataDir, 'logs'),
  pipePath: `\\\\.\\pipe\\${DEFAULT_PIPE_NAME}`
};

function readConfigFile() {
  if (!fs.existsSync(paths.configFile)) {
    return { value: {}, error: null };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(paths.configFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: {}, error: 'config file must contain a JSON object' };
    }
    return { value: parsed, error: null };
  } catch (err) {
    return { value: {}, error: `config file could not be parsed (${err.message})` };
  }
}

function pickString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function pickPositiveInt(fallback, min, max, ...candidates) {
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) {
      return Math.min(max, Math.max(min, Math.floor(value)));
    }
  }
  return fallback;
}

function normalizeApiBase(value) {
  return String(value).replace(/\/+$/, '');
}

function wsUrlFromApiBase(apiBase) {
  const url = new URL(apiBase);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('apiBase must use http or https');
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/api\/?$/i, '').replace(/\/+$/, '')}/device-ws`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function normalizeWsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('wsUrl must use ws or wss');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

function sanitizePipeName(value) {
  const name = pickString(value);
  if (!name) return DEFAULT_PIPE_NAME;
  if (name === '.' || name === '..') return DEFAULT_PIPE_NAME;
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : DEFAULT_PIPE_NAME;
}

function loadConfig() {
  const fileResult = readConfigFile();
  const file = fileResult.value;

  const apiBase = normalizeApiBase(
    pickString(process.env.ACEHRM_API_BASE, file.apiBase, file.api_base, DEFAULT_API_BASE)
  );

  const pipeName = sanitizePipeName(file.pipeName || file.pipe_name);
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const wsUrlOverride = pickString(process.env.ACEHRM_WS_URL, file.wsUrl, file.ws_url);

  return {
    apiBase,
    wsUrl: wsUrlOverride ? normalizeWsUrl(wsUrlOverride) : wsUrlFromApiBase(apiBase),
    enrollmentToken: pickString(
      process.env.ACEHRM_ENROLLMENT_TOKEN,
      file.enrollmentToken,
      file.enrollment_token
    ),
    heartbeatIntervalMs: pickPositiveInt(
      60_000,
      15_000,
      3_600_000,
      process.env.ACEHRM_HEARTBEAT_INTERVAL_MS,
      file.heartbeatIntervalMs,
      file.heartbeat_interval_ms
    ),
    inventoryIntervalMs: pickPositiveInt(
      900_000,
      60_000,
      86_400_000,
      process.env.ACEHRM_INVENTORY_INTERVAL_MS,
      file.inventoryIntervalMs,
      file.inventory_interval_ms
    ),
    httpTimeoutMs: pickPositiveInt(
      15_000,
      1_000,
      120_000,
      process.env.ACEHRM_HTTP_TIMEOUT_MS,
      file.httpTimeoutMs,
      file.http_timeout_ms
    ),
    reconnectBaseMs: pickPositiveInt(
      2_000,
      500,
      60_000,
      process.env.ACEHRM_RECONNECT_BASE_MS,
      file.reconnectBaseMs,
      file.reconnect_base_ms
    ),
    reconnectMaxMs: pickPositiveInt(
      60_000,
      5_000,
      300_000,
      process.env.ACEHRM_RECONNECT_MAX_MS,
      file.reconnectMaxMs,
      file.reconnect_max_ms
    ),
    enrollmentRetryMs: pickPositiveInt(
      60_000,
      10_000,
      3_600_000,
      process.env.ACEHRM_ENROLLMENT_RETRY_MS,
      file.enrollmentRetryMs,
      file.enrollment_retry_ms
    ),
    logLevel: pickString(process.env.ACEHRM_LOG_LEVEL, file.logLevel, file.log_level) || 'info',
    pipeName,
    pipePath,
    paths,
    configFile: paths.configFile,
    configFileError: fileResult.error,
    serviceName: SERVICE_NAME,
    serviceDisplayName: SERVICE_DISPLAY_NAME,
    agentVersion: AGENT_VERSION
  };
}

function ensureRuntimeDirectories(config) {
  fs.mkdirSync(config.paths.dataDir, { recursive: true });
  fs.mkdirSync(config.paths.stateDir, { recursive: true });
  try {
    fs.mkdirSync(config.paths.logsDir, { recursive: true });
  } catch {}
}

module.exports = {
  AGENT_VERSION,
  DEFAULT_API_BASE,
  DEFAULT_PIPE_NAME,
  SERVICE_DISPLAY_NAME,
  SERVICE_NAME,
  ensureRuntimeDirectories,
  loadConfig,
  paths,
  wsUrlFromApiBase
};
