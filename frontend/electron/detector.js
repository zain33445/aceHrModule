/**
 * detector.js — Active Window Detection Module
 *
 * Windows: native `tasklist` + PowerShell GetForegroundWindow.
 * macOS:   `ps -Ao comm=` + `lsappinfo` (no Automation prompt, no accessibility grant).
 * Linux:   `ps -Ao comm=` (process list only; foreground detection needs xdotool).
 */

import { exec } from 'child_process';
import { TARGET_APPS } from './config.js';
import { logger } from './logger.js';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function execAsync(command, timeoutMs = 5000) {
  return new Promise((resolve) => {
    exec(
      command,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) logger.warn(`Detector exec failed (${command}): ${err.message}`);
        resolve(err ? null : stdout);
      }
    );
  });
}

function matchTargets(names) {
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const matched = [];
  for (const target of TARGET_APPS) {
    const hit = lower.get(target.toLowerCase());
    if (hit && !matched.includes(hit)) matched.push(hit);
  }
  return matched;
}

function listWindowsProcesses() {
  return execAsync('tasklist /FO CSV /NH').then((stdout) => {
    if (stdout === null) return [];
    return stdout
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^"([^"]+)"/);
        return match ? match[1].replace(/\.exe$/i, '') : null;
      })
      .filter(Boolean);
  });
}

function listPosixProcesses() {
  // `/Applications/Plan Swift.app/Contents/MacOS/Plan Swift` -> `Plan Swift`
  return execAsync('ps -Ao comm=').then((stdout) => {
    if (stdout === null) return [];
    return stdout
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        const appSegment = trimmed.split('/').find((part) => part.endsWith('.app'));
        if (appSegment) return appSegment.replace(/\.app$/, '');
        return trimmed.split('/').pop() || null;
      })
      .filter(Boolean);
  });
}

/**
 * Check all running processes and return which target apps are currently running.
 * @returns {Promise<string[]>} Array of running target app names
 */
export function getRunningTargetApps() {
  const list = IS_WIN ? listWindowsProcesses() : listPosixProcesses();
  return list
    .then(matchTargets)
    .catch((err) => {
      logger.error(`Detector process list error: ${err.message}`);
      return [];
    });
}

function getWindowsForegroundProcess() {
  const psScript = [
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class Win32 {',
    '  [DllImport("user32.dll")]',
    '  public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")]',
    '  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
    '}',
    '"@',
    '$hwnd = [Win32]::GetForegroundWindow()',
    '$pid = 0',
    '[Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null',
    'if ($pid -gt 0) { (Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName }',
  ].join('; ');

  return execAsync(`powershell -NoProfile -Command "${psScript}"`, 3000);
}

function getMacForegroundProcess() {
  // lsappinfo is not TCC-gated, so this never triggers an Automation prompt.
  const cmd = "asn=$(lsappinfo front 2>/dev/null); [ -n \"$asn\" ] && lsappinfo info -only name \"$asn\"";
  return execAsync(cmd, 3000).then((stdout) => stdout || null);
}

function getLinuxForegroundProcess() {
  return execAsync("xdotool getactivewindow getwindowpid 2>/dev/null | xargs -r -I{} ps -p {} -o comm=", 3000).then(
    (stdout) => stdout || null
  );
}

/**
 * Get the name of the currently active foreground window process.
 * NOTE: This is only called on-demand for specific events, not every poll cycle.
 * @returns {Promise<string|null>} Process name (e.g., "Zoom") or null
 */
export function getActiveWindowProcess() {
  let pending;
  if (IS_WIN) pending = getWindowsForegroundProcess();
  else if (IS_MAC) pending = getMacForegroundProcess();
  else pending = getLinuxForegroundProcess();

  return pending
    .then((stdout) => (stdout ? stdout.trim().split(/\r?\n/)[0].trim() : null))
    .catch((err) => {
      logger.error(`Detector foreground error: ${err.message}`);
      return null;
    });
}

/**
 * Check if a specific target app is the active foreground window.
 * @returns {Promise<string|null>} Matched target app name or null
 */
export async function detectActiveTargetApp() {
  const activeProcess = await getActiveWindowProcess();
  if (!activeProcess) return null;

  const match = TARGET_APPS.find(
    (app) => app.toLowerCase() === activeProcess.toLowerCase()
  );

  return match || null;
}