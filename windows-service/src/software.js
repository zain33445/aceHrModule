'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { requestJson } = require('./http');
const { ensurePrivateDirectory } = require('./identity');

const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const RESTART_REQUIRED_CODES = new Set([3010, 1641]);
const INSTALLER_POLICY = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\Installer';

let queue = Promise.resolve();
const running = new Map();

/** Splits a switch string without a shell. Quotes group words and are removed. */
function parseArgs(text) {
  return (String(text || '').match(/"[^"]*"|[^\s"]+/g) || []).map((part) => part.replace(/"/g, ''));
}

function validatePayload(payload) {
  const valid =
    payload &&
    /^[0-9a-f-]{36}$/.test(String(payload.package_id)) &&
    /^[0-9a-f]{64}$/.test(String(payload.sha256)) &&
    (payload.kind === 'msi' || payload.kind === 'exe');
  return valid ? null : 'The install request is invalid';
}

function installerCommand(kind, file, silentArgs) {
  const args = parseArgs(silentArgs);
  return kind === 'msi'
    ? { command: 'msiexec.exe', args: ['/i', file, '/qn', '/norestart', ...args] }
    : { command: file, args };
}

function describeExit(exitCode) {
  if (exitCode === 0) return { ok: true, restart_required: false };
  if (RESTART_REQUIRED_CODES.has(exitCode)) return { ok: true, restart_required: true };
  return { ok: false, restart_required: false };
}

async function downloadVerified({ url, token, file, sha256 }) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with HTTP ${response.status}`);
  }

  const hash = crypto.createHash('sha256');
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      }
    }),
    fs.createWriteStream(file, { mode: 0o600 })
  );

  if (hash.digest('hex') !== sha256) {
    throw new Error('Downloaded file failed its integrity check, so it was not run');
  }
}

function runInstaller({ command, args, cwd }) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: INSTALL_TIMEOUT_MS, windowsHide: true },
      (err) => {
        if (!err) resolve({ exitCode: 0 });
        else if (err.killed) resolve({ timedOut: true });
        else if (typeof err.code === 'number') resolve({ exitCode: err.code });
        else resolve({ startError: err.message });
      }
    );
  });
}

function powershell(script, env, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, env: env ? { ...process.env, ...env } : process.env },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim()))
    );
  });
}

/**
 * The .msi block policy would also stop admin-pushed installs, so it is lifted
 * for the duration. If the service dies first, the policy recheck restores it.
 * ponytail: a recheck landing mid-install can re-block a chained .msi; pause
 * rechecks during installs if that shows up in practice.
 */
async function liftInstallerBlock() {
  const out = await powershell(
    `$v = (Get-ItemProperty -Path "${INSTALLER_POLICY}" -Name DisableMSI -ErrorAction SilentlyContinue).DisableMSI; if ($v -in 1,2) { Set-ItemProperty -Path "${INSTALLER_POLICY}" -Name DisableMSI -Value 0 -ErrorAction Stop; "$v" }`
  );
  return out === '1' || out === '2' ? Number(out) : null;
}

async function restoreInstallerBlock(value) {
  await powershell(
    `Set-ItemProperty -Path "${INSTALLER_POLICY}" -Name DisableMSI -Value ${Number(value)} -ErrorAction Stop`
  );
}

const TRUST_TIMEOUT_MS = 10 * 60_000;

// The path travels in the environment, never in the script text.
const TRUST_SCRIPT = `$sig = Get-AuthenticodeSignature -LiteralPath $env:ACEHRM_TRUST_FILE
if ($sig.Status -ne 'Valid' -or -not $sig.SignerCertificate) { @{ trusted = $false; status = "$($sig.Status)" } | ConvertTo-Json -Compress; exit 0 }
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('TrustedPublisher','LocalMachine')
$store.Open('ReadWrite'); try { $store.Add($sig.SignerCertificate) } finally { $store.Close() }
@{ trusted = $true; subject = $sig.SignerCertificate.Subject; thumbprint = $sig.SignerCertificate.Thumbprint } | ConvertTo-Json -Compress`;

/** Adds a validly signed installer's publisher to LocalMachine TrustedPublisher so its drivers install without a prompt. */
async function trustSigner(file, run = powershell) {
  // Get-AuthenticodeSignature hashes the whole file (uploads reach 2 GB).
  return JSON.parse(await run(TRUST_SCRIPT, { ACEHRM_TRUST_FILE: file }, TRUST_TIMEOUT_MS));
}

const defaultDeps = {
  download: downloadVerified,
  trustSigner,
  run: runInstaller,
  liftBlock: liftInstallerBlock,
  restoreBlock: restoreInstallerBlock,
  request: requestJson,
  ensureDir: ensurePrivateDirectory
};

async function performInstall(payload, context, deps) {
  const problem = validatePayload(payload);
  if (problem) return { ok: false, code: 'INVALID_PACKAGE', message: problem };

  const { config, getCredentials, logger } = context;
  const name = String(payload.name || payload.package_id);
  // The private folder stops a signed-in user swapping the file after it is verified.
  const dir = path.join(config.paths.stateDir, 'software');
  const file = path.join(dir, `${payload.package_id}.${payload.kind}`);
  let lifted = null;

  try {
    deps.ensureDir(dir, logger);
    await deps.download({
      url: `${config.apiBase}/device/software/${payload.package_id}/download`,
      token: getCredentials()?.deviceToken,
      file,
      sha256: payload.sha256
    });

    try {
      // Trust stays after the install so the app's later driver updates don't prompt either.
      const trust = await deps.trustSigner(file);
      logger?.info(
        trust.trusted
          ? `Trusted installer signer ${trust.subject} (${trust.thumbprint})`
          : `Installer signer not trusted (signature ${trust.status})`
      );
    } catch (err) {
      logger?.warn(`Could not trust the installer signer: ${err.message}`);
    }

    lifted = await deps.liftBlock();
    logger?.info(`Installing ${name}`);
    const result = await deps.run({
      ...installerCommand(payload.kind, file, payload.silent_args),
      cwd: dir
    });

    if (result.timedOut) {
      return { ok: false, code: 'INSTALL_TIMEOUT', message: `${name} did not finish within 30 minutes` };
    }
    if (result.startError) {
      return { ok: false, code: 'INSTALL_START_FAILED', message: result.startError };
    }

    const outcome = describeExit(result.exitCode);
    const message = outcome.ok
      ? `${name} installed${outcome.restart_required ? '; a restart is required' : ''}`
      : `${name} failed with exit code ${result.exitCode}`;
    return {
      ok: outcome.ok,
      code: outcome.ok ? null : 'INSTALL_FAILED',
      message,
      result: { message, exit_code: result.exitCode, restart_required: outcome.restart_required }
    };
  } catch (err) {
    return { ok: false, code: 'INSTALL_FAILED', message: err.message || 'Install failed' };
  } finally {
    if (lifted) {
      await deps.restoreBlock(lifted).catch((err) => {
        logger?.warn(`Could not restore the installer block: ${err.message}`);
      });
    }
    fs.rmSync(file, { force: true });
  }
}

/**
 * Installs run one at a time, because Windows Installer allows only one. The
 * result also goes over HTTP since the socket may have dropped during a long install.
 */
function installSoftware(payload, context, deps = defaultDeps) {
  const { commandId, config, getCredentials, logger } = context;
  if (commandId && running.has(commandId)) return running.get(commandId);

  const job = queue.then(async () => {
    const outcome = await performInstall(payload, context, deps);
    if (!outcome.result) outcome.result = { message: outcome.message };
    logger?.info(`Install finished: ${outcome.message}`);

    if (commandId) {
      await deps
        .request(`${config.apiBase}/device/commands/${commandId}/result`, {
          method: 'POST',
          token: getCredentials()?.deviceToken,
          body: { status: outcome.ok ? 'completed' : 'failed', result: outcome.result },
          timeoutMs: config.httpTimeoutMs
        })
        .catch((err) => logger?.warn(`Could not report the install result: ${err.message}`));
    }
    return outcome;
  });

  queue = job.catch(() => {});
  if (commandId) {
    running.set(commandId, job);
    job.finally(() => running.delete(commandId)).catch(() => {});
  }
  return job;
}

module.exports = {
  describeExit,
  downloadVerified,
  installSoftware,
  installerCommand,
  parseArgs,
  runInstaller,
  trustSigner,
  TRUST_SCRIPT,
  validatePayload
};
