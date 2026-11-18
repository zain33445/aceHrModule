'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function normalizeLevel(value) {
  const level = String(value || '').toLowerCase();
  return LEVELS[level] ? level : 'info';
}

function pickWritableDirectory(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function rotateIfNeeded(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size < MAX_LOG_BYTES) return;
    const archive = `${file}.1`;
    try { fs.unlinkSync(archive); } catch {}
    fs.renameSync(file, archive);
  } catch {}
}

function createLogger(options = {}) {
  const level = normalizeLevel(options.level);
  const threshold = LEVELS[level];
  const consoleEnabled = Boolean(options.console);
  const fallbackDir = path.join(__dirname, '..', 'logs');
  const logDir = pickWritableDirectory([
    options.logDir,
    fallbackDir,
    path.join(os.tmpdir(), 'acehrm-device-service-logs')
  ]);
  const logFile = logDir ? path.join(logDir, 'device-service.log') : null;
  let fileWarningShown = false;
  let writesSinceRotateCheck = 0;

  if (logFile) rotateIfNeeded(logFile);

  function write(levelName, message) {
    if (LEVELS[levelName] < threshold) return;
    const line = `${new Date().toISOString()} [${levelName.toUpperCase()}] ${message}`;

    if (logFile) {
      try {
        writesSinceRotateCheck += 1;
        if (writesSinceRotateCheck >= 100) {
          writesSinceRotateCheck = 0;
          rotateIfNeeded(logFile);
        }
        fs.appendFileSync(logFile, `${line}\n`, 'utf8');
      } catch (err) {
        if (!fileWarningShown) {
          fileWarningShown = true;
          console.error(`aceHRM device service: file logging disabled (${err.message})`);
        }
      }
    }

    if (consoleEnabled) {
      const stream = levelName === 'error' ? console.error : levelName === 'warn' ? console.warn : console.log;
      stream(line);
    }
  }

  return {
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    level,
    logDir,
    logFile
  };
}

module.exports = { createLogger, normalizeLevel };
