/**
 * detector.js — Active Window Detection Module
 * 
 * Uses the native Windows `tasklist` command for lightweight process detection.
 * Avoids spawning heavy PowerShell instances on every poll cycle.
 */

import { exec } from 'child_process';
import { TARGET_APPS } from './config.js';
import { logger } from './logger.js';

/**
 * Check all running processes and return which target apps are currently running.
 * Uses the native `tasklist` command (fast, lightweight) instead of PowerShell.
 * @returns {Promise<string[]>} Array of running target app names
 */
export function getRunningTargetApps() {
  return new Promise((resolve) => {
    // tasklist is a native Windows command — much lighter than PowerShell
    // /FO CSV = CSV format for easy parsing
    // /NH = No header row
    exec(
      'tasklist /FO CSV /NH',
      { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          logger.error(`Detector tasklist error: ${err.message}`);
          resolve([]);
          return;
        }

        // Parse CSV output: each line is like "processname.exe","PID","Session","SessionNum","MemUsage"
        const runningProcesses = stdout
          .split(/\r?\n/)
          .map(line => {
            const match = line.match(/^"([^"]+)"/);
            if (match) {
              // Remove .exe extension for matching
              return match[1].replace(/\.exe$/i, '');
            }
            return null;
          })
          .filter(Boolean);

        // Match against target apps (case-insensitive)
        const matched = [];
        const seen = new Set();

        for (const processName of runningProcesses) {
          for (const target of TARGET_APPS) {
            if (
              processName.toLowerCase() === target.toLowerCase() &&
              !seen.has(target.toLowerCase())
            ) {
              seen.add(target.toLowerCase());
              matched.push(target);
            }
          }
        }

        resolve(matched);
      }
    );
  });
}

/**
 * Get the name of the currently active foreground window process.
 * Uses PowerShell to call Win32 GetForegroundWindow.
 * NOTE: This is only called on-demand for specific events, not every poll cycle.
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
      { timeout: 3000, windowsHide: true },
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
