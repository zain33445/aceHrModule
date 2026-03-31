/**
 * detector.js — Active Window Detection Module
 * 
 * Uses PowerShell + Win32 API to detect the currently active foreground window.
 * Also queries all running processes to find target apps.
 * No external npm dependencies required.
 */

import { exec } from 'child_process';
import { TARGET_APPS } from './config.js';
import { logger } from './logger.js';

/**
 * Get the name of the currently active foreground window process.
 * Uses PowerShell to call Win32 GetForegroundWindow.
 * @returns {Promise<string|null>} Process name (e.g., "Zoom") or null
 */
export function getActiveWindowProcess() {
  return new Promise((resolve) => {
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

    exec(
      `powershell -NoProfile -Command "${psScript}"`,
      { timeout: 3000 },
      (err, stdout) => {
        if (err) {
          logger.error(`Detector exec error: ${err.message}`);
          resolve(null);
          return;
        }
        const processName = stdout.trim();
        resolve(processName || null);
      }
    );
  });
}

/**
 * Check all running processes and return which target apps are currently running.
 * @returns {Promise<string[]>} Array of running target app names
 */
export function getRunningTargetApps() {
  return new Promise((resolve) => {
    const names = TARGET_APPS.map(app => `'${app}'`).join(',');
    const psCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process -Name ${names} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName -Unique"`;

    exec(
      psCommand,
      { timeout: 5000, maxBuffer: 1024 * 1024 }, // 1MB buffer
      (err, stdout, stderr) => {
        if (err && !stdout) {
          // err is non-null if no processes matched (exit code 1), 
          // but we only care if it's a real execution error.
          // Get-Process -ErrorAction SilentlyContinue returns exit code 1 if NOTHING matches.
          if (stderr) {
            logger.error(`Detector process list error: ${stderr}`);
          }
          resolve([]);
          return;
        }

        const matchedApps = stdout
          .split(/\r?\n/)
          .map((p) => p.trim())
          .filter(Boolean);

        resolve(matchedApps);
      }
    );
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
