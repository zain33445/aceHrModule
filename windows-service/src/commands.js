'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { installSoftware } = require('./software');

const execFileAsync = promisify(execFile);

function psScript(script) {
  return execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 30_000, windowsHide: true }
  );
}

// The service runs as SYSTEM in session 0, where LockWorkStation succeeds without locking
// anything. A throwaway task runs it as the signed-in user, then LogonUI confirms the lock.
const LOCK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { exit 3 }',
  "$name = 'aceHRMLockWorkstation'",
  "$action = New-ScheduledTaskAction -Execute 'rundll32.exe' -Argument 'user32.dll,LockWorkStation'",
  "$principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-4' -RunLevel Limited",
  '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
  'Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Force | Out-Null',
  '$locked = $false',
  'try {',
  '  Start-ScheduledTask -TaskName $name',
  '  foreach ($i in 1..16) {',
  '    if (Get-Process LogonUI -ErrorAction SilentlyContinue) { $locked = $true; break }',
  '    Start-Sleep -Milliseconds 500',
  '  }',
  '} finally {',
  '  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue',
  '}',
  'if (-not $locked) { exit 4 }'
].join('\n');

function lockOutcome(err) {
  if (!err) return { ok: true, message: 'Workstation locked' };
  if (err.code === 3) {
    return { ok: false, code: 'NO_USER_SIGNED_IN', message: 'No user is signed in, so there is nothing to lock' };
  }
  if (err.code === 4) {
    return { ok: false, code: 'LOCK_FAILED', message: 'The lock request ran, but the PC did not lock' };
  }
  return { ok: false, code: 'LOCK_FAILED', message: err.message || 'Failed to lock workstation' };
}

async function lockWorkstation() {
  try {
    await psScript(LOCK_SCRIPT);
    return lockOutcome(null);
  } catch (err) {
    return lockOutcome(err);
  }
}

async function restartDevice() {
  try {
    await execFileAsync('shutdown.exe', ['/r', '/t', '0', '/f'], { timeout: 15_000, windowsHide: true });
    return { ok: true, message: 'Restart initiated' };
  } catch (err) {
    return { ok: false, code: 'RESTART_FAILED', message: err.message || 'Failed to restart device' };
  }
}

async function shutdownDevice() {
  try {
    await execFileAsync('shutdown.exe', ['/s', '/t', '0', '/f'], { timeout: 15_000, windowsHide: true });
    return { ok: true, message: 'Shutdown initiated' };
  } catch (err) {
    return { ok: false, code: 'SHUTDOWN_FAILED', message: err.message || 'Failed to shut down device' };
  }
}

async function executeDeviceCommand(type, payload, context = {}) {
  const normalized = String(type || '').toLowerCase().trim();
  switch (normalized) {
    case 'lock':
      return lockWorkstation();
    case 'restart':
      return restartDevice();
    case 'shutdown':
      return shutdownDevice();
    case 'software_install':
      return installSoftware(payload, context);
    default:
      return {
        ok: false,
        code: 'UNSUPPORTED_COMMAND',
        message: `Command type "${type}" is not supported by this agent`
      };
  }
}

module.exports = { LOCK_SCRIPT, executeDeviceCommand, lockOutcome };
