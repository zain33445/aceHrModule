'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { paths } = require('./config');

const isWindows = process.platform === 'win32';
const securedDirectories = new Set();
let dpapiLoaded = false;
let dpapiModule = null;

function loadDpapi() {
  if (dpapiLoaded) return dpapiModule;
  dpapiLoaded = true;

  if (!isWindows) return null;

  try {
    const loaded = require('win-dpapi');
    const candidate = loaded && typeof loaded.protectData === 'function' ? loaded : loaded?.default;
    if (
      candidate &&
      typeof candidate.protectData === 'function' &&
      typeof candidate.unprotectData === 'function'
    ) {
      dpapiModule = candidate;
    }
  } catch {}

  return dpapiModule;
}

function secretStorageMode() {
  return loadDpapi() ? 'dpapi-local-machine' : 'acl-only';
}

function runIcacls(args, logger) {
  try {
    execFileSync('icacls.exe', args, { stdio: 'ignore', timeout: 10_000, windowsHide: true });
    return true;
  } catch (err) {
    logger?.warn(`Could not apply ACL to ${args[0]}: ${err.message}`);
    return false;
  }
}

function currentUserAccount() {
  try {
    const account = execFileSync('whoami.exe', {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true
    }).trim();
    return account || null;
  } catch {
    return null;
  }
}

function applyRestrictiveAcl(target, options = {}) {
  if (!isWindows) return;
  const { directory = false, logger } = options;
  const permission = directory ? '(OI)(CI)(F)' : '(F)';
  const args = [
    target,
    '/inheritance:r',
    '/grant:r',
    `*S-1-5-18:${permission}`,
    `*S-1-5-32-544:${permission}`
  ];

  if (!runIcacls(args, logger)) return;

  const account = currentUserAccount();
  if (!account || /\\system$/i.test(account) || /^nt authority\\system$/i.test(account)) return;
  runIcacls([target, '/grant', `${account}:${permission}`], logger);
}

function ensurePrivateDirectory(directory, logger) {
  fs.mkdirSync(directory, { recursive: true });
  if (!securedDirectories.has(directory)) {
    applyRestrictiveAcl(directory, { directory: true, logger });
    securedDirectories.add(directory);
  }
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeSecureJson(file, value, logger) {
  ensurePrivateDirectory(path.dirname(file), logger);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    applyRestrictiveAcl(temp, { logger });
    fs.renameSync(temp, file);
    applyRestrictiveAcl(file, { logger });
  } catch (err) {
    try { fs.unlinkSync(temp); } catch {}
    throw err;
  }
}

function getMachineGuid(logger) {
  if (!isWindows) return null;

  const script = [
    "$ErrorActionPreference='Stop'",
    "(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid"
  ].join('; ');

  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true }
    ).trim();

    return /^[0-9a-f-]{32,40}$/i.test(output) ? output : null;
  } catch (err) {
    logger?.warn(`Could not read the Windows MachineGuid: ${err.message}`);
    return null;
  }
}

function identitySnapshot() {
  return {
    hostname: os.hostname(),
    os_name: isWindows ? 'Windows' : os.type(),
    os_version: os.release(),
    arch: os.arch()
  };
}

function getOrCreateIdentity(options = {}) {
  const { logger } = options;
  let identity;

  ensurePrivateDirectory(path.dirname(paths.identityFile), logger);

  try {
    identity = readJson(paths.identityFile);
  } catch (err) {
    throw new Error(`Device identity file is unreadable at ${paths.identityFile}: ${err.message}`);
  }

  if (identity) applyRestrictiveAcl(paths.identityFile, { logger });

  if (!identity) {
    const now = new Date().toISOString();
    const snapshot = identitySnapshot();
    identity = {
      version: 1,
      device_key: crypto.randomUUID(),
      machine_guid: getMachineGuid(logger),
      ...snapshot,
      created_at: now,
      updated_at: now
    };
    writeSecureJson(paths.identityFile, identity, logger);
    logger?.info(`Created a new device identity for ${identity.hostname}`);
    return identity;
  }

  if (!identity || typeof identity !== 'object' || typeof identity.device_key !== 'string' || !identity.device_key) {
    throw new Error(`Device identity file at ${paths.identityFile} is missing device_key`);
  }

  let changed = false;
  const snapshot = identitySnapshot();

  for (const [key, value] of Object.entries(snapshot)) {
    if (identity[key] !== value) {
      identity[key] = value;
      changed = true;
    }
  }

  if (!identity.machine_guid) {
    const machineGuid = getMachineGuid(logger);
    if (machineGuid) {
      identity.machine_guid = machineGuid;
      changed = true;
    }
  }

  if (changed) {
    identity.updated_at = new Date().toISOString();
    writeSecureJson(paths.identityFile, identity, logger);
  }

  logger?.info(`Loaded device identity for ${identity.hostname}`);
  return identity;
}

function protectSecret(value) {
  const dpapi = loadDpapi();
  if (dpapi) {
    try {
      const protectedBuffer = dpapi.protectData(
        Buffer.from(String(value), 'utf8'),
        null,
        'LocalMachine'
      );
      if (protectedBuffer) {
        return {
          scheme: 'dpapi-local-machine',
          value: Buffer.from(protectedBuffer).toString('base64')
        };
      }
    } catch {}
  }

  return { scheme: 'plain', value: String(value) };
}

function unprotectSecret(stored) {
  if (!stored || typeof stored !== 'object') return null;
  if (stored.scheme === 'plain') {
    return typeof stored.value === 'string' && stored.value ? stored.value : null;
  }
  if (stored.scheme === 'dpapi-local-machine' || stored.scheme === 'dpapi-current-user') {
    const dpapi = loadDpapi();
    if (!dpapi || typeof stored.value !== 'string') return null;
    const scope = stored.scheme === 'dpapi-current-user' ? 'CurrentUser' : 'LocalMachine';
    try {
      const clear = dpapi.unprotectData(Buffer.from(stored.value, 'base64'), null, scope);
      return Buffer.from(clear).toString('utf8') || null;
    } catch {
      return null;
    }
  }
  return null;
}

function loadCredentials(options = {}) {
  const { logger } = options;
  let stored;

  if (fs.existsSync(paths.credentialsFile)) {
    applyRestrictiveAcl(paths.credentialsFile, { logger });
  }

  try {
    stored = readJson(paths.credentialsFile);
  } catch (err) {
    logger?.warn(`Device credentials file is unreadable: ${err.message}`);
    return null;
  }

  if (!stored) return null;

  const deviceToken = unprotectSecret(stored.device_token);
  if (!stored.device_id || !deviceToken) {
    logger?.warn('Device credentials are incomplete or could not be decrypted; enrollment is required');
    return null;
  }

  return {
    deviceId: String(stored.device_id),
    deviceToken,
    expiresAt: Number(stored.expires_at) || 0,
    updatedAt: stored.updated_at || null,
    storage: stored.device_token.scheme || 'unknown'
  };
}

function saveCredentials(credentials, options = {}) {
  const { logger } = options;
  if (!credentials?.deviceId || !credentials?.deviceToken) {
    throw new Error('saveCredentials requires deviceId and deviceToken');
  }

  writeSecureJson(
    paths.credentialsFile,
    {
      version: 1,
      device_id: credentials.deviceId,
      device_token: protectSecret(credentials.deviceToken),
      expires_at: Number(credentials.expiresAt) || 0,
      updated_at: new Date().toISOString()
    },
    logger
  );

  return loadCredentials({ logger });
}

function clearCredentials(options = {}) {
  const { logger } = options;
  try {
    fs.unlinkSync(paths.credentialsFile);
    logger?.info('Stored device credentials removed');
  } catch (err) {
    if (err.code !== 'ENOENT') logger?.warn(`Could not remove device credentials: ${err.message}`);
  }
}

module.exports = {
  clearCredentials,
  ensurePrivateDirectory,
  getMachineGuid,
  getOrCreateIdentity,
  loadCredentials,
  saveCredentials,
  secretStorageMode,
  writeSecureJson
};
