/**
 * logger.js — File-based Logging Utility
 * 
 * Writes timestamped log entries to monitoring.log in the app's userData directory.
 * Levels: info, warn, error
 */

import fs from 'fs';
import path from 'path';
import electronPkg from 'electron';
const { app } = electronPkg;

// Log file path — stored in Electron's userData folder. Resolved on each write:
// main.js changes userData after this module is imported (dev / ACEHRM_USER_DATA).
const logFile = () => path.join(app.getPath('userData'), 'monitoring.log');

/**
 * Append a log entry with timestamp and level.
 * @param {'info'|'warn'|'error'} level 
 * @param {string} message 
 */
function log(level, message) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

  try {
    fs.appendFileSync(logFile(), entry, 'utf-8');
  } catch (err) {
    console.error('Logger write failed:', err.message);
  }

  // Also print to console for development
  if (level === 'error') {
    console.error(entry.trim());
  } else {
    console.log(entry.trim());
  }
}

export const logger = {
  info: (msg) => log('info', msg),
  warn: (msg) => log('warn', msg),
  error: (msg) => log('error', msg),
  debug: (msg) => log('debug', msg),
  getLogPath: () => logFile(),
};
